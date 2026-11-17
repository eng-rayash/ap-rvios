import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, NotEquals } from 'class-validator';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { ShopSection } from '../../../common/tenant/shop-sections';

export class AdjustPointsDto {
  /** موجب يضيف، سالب يخصم (لا يتجاوز الرصيد) */
  @IsInt() @NotEquals(0) @Min(-100_000_000) @Max(100_000_000) amount!: number;
  @IsOptional() @IsString() @MaxLength(120) note?: string;
}

type Tx = Prisma.TransactionClient;

/**
 * برنامج المكافآت: نسبة من إجمالي كل طلب مكتمل تُضاف رصيدًا للعميل (بعملة المتجر)، وتُسحب إن
 * أُرجع الطلب. الصرف عبر التاجر (طلب يدوي أو تعديل الرصيد) — العميل بلا حساب، فالصرف من
 * واجهة المتجر برقم الجوال وحده يسمح لأي أحد بصرف رصيد غيره.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  /** عند اكتمال الطلب — مرة واحدة لكل طلب */
  async earn(tx: Tx, order: { id: string; storeId: string; companyId: string; customerId: string | null; total: number; ref: string }, rate: number) {
    if (!order.customerId || rate <= 0) return;
    const amount = Math.floor((order.total * rate) / 100);
    if (amount <= 0) return;
    if (await tx.shopPointsTx.findFirst({ where: { orderId: order.id, kind: 'earn' }, select: { id: true } })) return;
    await tx.shopCustomer.update({ where: { id: order.customerId }, data: { points: { increment: amount } } });
    await tx.shopPointsTx.create({ data: { companyId: order.companyId, storeId: order.storeId, customerId: order.customerId, orderId: order.id, amount, kind: 'earn', note: `طلب ${order.ref}` } });
  }

  /** عند إرجاع الطلب — يُسحب ما كُسب منه (بقدر الرصيد المتبقي) */
  async revoke(tx: Tx, orderId: string) {
    const e = await tx.shopPointsTx.findFirst({ where: { orderId, kind: 'earn' } });
    if (!e) return;
    if (await tx.shopPointsTx.findFirst({ where: { orderId, kind: 'revoke' }, select: { id: true } })) return;
    const c = await tx.shopCustomer.findUnique({ where: { id: e.customerId }, select: { points: true } });
    const take = Math.min(e.amount, c?.points ?? 0);
    if (take > 0) await tx.shopCustomer.update({ where: { id: e.customerId }, data: { points: { decrement: take } } });
    await tx.shopPointsTx.create({ data: { companyId: e.companyId, storeId: e.storeId, customerId: e.customerId, orderId, amount: -take, kind: 'revoke', note: 'طلب مُرجَع' } });
  }

  /** صرف داخل طلب يدوي — خصم شرطي ذرّي فلا يُصرف أكثر من الرصيد */
  async redeem(tx: Tx, storeId: string, companyId: string, customerId: string, amount: number, orderId: string, ref: string) {
    const r = await tx.shopCustomer.updateMany({ where: { id: customerId, storeId, points: { gte: amount } }, data: { points: { decrement: amount } } });
    if (!r.count) throw new BadRequestException('رصيد مكافآت العميل لا يكفي');
    await tx.shopPointsTx.create({ data: { companyId, storeId, customerId, orderId, amount: -amount, kind: 'redeem', note: `طلب ${ref}` } });
  }

  /** طلب أُلغي: ما صُرف فيه من مكافآت يعود للعميل */
  async unredeem(tx: Tx, orderId: string) {
    const r = await tx.shopPointsTx.findFirst({ where: { orderId, kind: 'redeem' } });
    if (!r || (await tx.shopPointsTx.findFirst({ where: { orderId, kind: 'unredeem' }, select: { id: true } }))) return;
    await tx.shopCustomer.update({ where: { id: r.customerId }, data: { points: { increment: -r.amount } } });
    await tx.shopPointsTx.create({ data: { companyId: r.companyId, storeId: r.storeId, customerId: r.customerId, orderId, amount: -r.amount, kind: 'unredeem', note: 'طلب ملغى' } });
  }

  async history(ctx: TenantContext, storeId: string, customerId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const c = await db.shopCustomer.findFirst({ where: { id: customerId, storeId }, select: { id: true, name: true, phone: true, points: true } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    const txs = await db.shopPointsTx.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { customer: c, history: txs };
  }

  async adjust(ctx: TenantContext, storeId: string, customerId: string, dto: AdjustPointsDto) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const c = await db.shopCustomer.findFirst({ where: { id: customerId, storeId } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    if (c.points + dto.amount < 0) throw new BadRequestException('لا يُخصم أكثر من الرصيد');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.shopCustomer.update({ where: { id: c.id }, data: { points: { increment: dto.amount } } });
      await tx.shopPointsTx.create({ data: { companyId: c.companyId, storeId, customerId: c.id, amount: dto.amount, kind: 'adjust', note: (dto.note ?? '').trim() } });
      return { points: u.points };
    });
  }
}

@ShopSection('customers')
@Controller('shop/stores/:storeId/customers/:customerId/points')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  history(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.loyalty.history(ctx, storeId, customerId);
  }

  @RequireRole(UserRole.DeptManager)
  @Post()
  adjust(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('customerId', ParseUUIDPipe) customerId: string, @Body() dto: AdjustPointsDto) {
    return this.loyalty.adjust(ctx, storeId, customerId, dto);
  }
}
