import { BadRequestException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Prisma, ShopStore } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { variantPrice } from '../catalog/catalog.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { storePublicUrl, symbolOf, toE164 } from '../shop.constants';
import { ShopSection } from '../../../common/tenant/shop-sections';
import { PlanFeature } from '../plan-feature.guard';

export class CartLineDto {
  @IsUUID() id!: string;
  @IsOptional() @IsUUID() variantId?: string;
  @IsInt() @Min(1) @Max(99) qty!: number;
}

export class SaveCartDto {
  @IsString() @MaxLength(20) phone!: string;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartLineDto) lines!: CartLineDto[];
}

/** 0 متروكة · 1 أُكملت بطلب */
export enum CartStatus {
  Open = 0,
  Recovered = 1,
}

/** لا تُعدّ «متروكة» قبل هذه المدة — العميل ربما ما زال يكتب عنوانه */
const IDLE_MS = 30 * 60_000;
const KEEP_DAYS = 30;

type Tx = Prisma.TransactionClient;

/**
 * السلات المتروكة: حين يكتب العميل جواله في صفحة الإتمام تُحفظ سلته (بأسعار القاعدة)، فإن لم
 * يُكمل يراها التاجر مع رسالة واتساب جاهزة للتذكير. طلب لاحق بالرقم نفسه يجعلها «مُستعادة».
 */
@Injectable()
export class ShopCartsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  async save(store: ShopStore, dto: SaveCartDto) {
    const phone = toE164(dto.phone, store.country);
    if (!phone) throw new BadRequestException('رقم الجوال غير صالح');
    const items: { productId: string; variantId: string | null; name: string; qty: number; price: number }[] = [];
    for (const l of dto.lines) {
      const p = await this.prisma.shopProduct.findFirst({ where: { id: l.id, storeId: store.id, live: true } });
      if (!p) continue;
      const v = l.variantId ? await this.prisma.shopProductVariant.findFirst({ where: { id: l.variantId, productId: p.id } }) : null;
      items.push({ productId: p.id, variantId: v?.id ?? null, name: v ? `${p.name} (${[v.v1, v.v2].filter(Boolean).join(' / ')})` : p.name, qty: l.qty, price: v ? variantPrice(p, v) : p.price });
    }
    if (!items.length) return { ok: true };
    const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
    const data = { name: (dto.name ?? '').trim().slice(0, 60), items: items as unknown as Prisma.InputJsonValue, subtotal, status: CartStatus.Open, recoveredOrderId: null, remindedAt: null };
    await this.prisma.shopCart.upsert({
      where: { storeId_phone: { storeId: store.id, phone } },
      create: { companyId: store.companyId, storeId: store.id, phone, ...data },
      update: data,
    });
    return { ok: true };
  }

  /** داخل معاملة الطلب: سلة الرقم نفسه صارت طلبًا */
  async recover(tx: Tx, storeId: string, phone: string, orderId: string) {
    if (!phone) return;
    await tx.shopCart.updateMany({ where: { storeId, phone, status: CartStatus.Open }, data: { status: CartStatus.Recovered, recoveredOrderId: orderId } });
  }

  async list(ctx: TenantContext, storeId: string, status?: number) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    await db.shopCart.deleteMany({ where: { storeId, updatedAt: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
    const idle = new Date(Date.now() - IDLE_MS);
    const where = status === CartStatus.Recovered ? { storeId, status: CartStatus.Recovered } : { storeId, status: CartStatus.Open, updatedAt: { lt: idle } };
    const [rows, open, recovered, value] = await Promise.all([
      db.shopCart.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
      db.shopCart.count({ where: { storeId, status: CartStatus.Open, updatedAt: { lt: idle } } }),
      db.shopCart.count({ where: { storeId, status: CartStatus.Recovered } }),
      db.shopCart.aggregate({ where: { storeId, status: CartStatus.Open, updatedAt: { lt: idle } }, _sum: { subtotal: true } }),
    ]);
    const cur = symbolOf(store.country);
    return {
      carts: rows.map((c) => ({ ...c, wa: this.reminder(store, c.phone, c.name, c.items as unknown as { name: string; qty: number }[], c.subtotal, cur) })),
      stats: { open, recovered, openValue: value._sum.subtotal ?? 0, rate: open + recovered ? Math.round((recovered / (open + recovered)) * 100) : 0 },
    };
  }

  /** رسالة التذكير من رقم التاجر إلى العميل — رابط واتساب جاهز */
  private reminder(store: ShopStore, phone: string, name: string, items: { name: string; qty: number }[], subtotal: number, cur: string) {
    const lines = items.slice(0, 6).map((i) => `• ${i.name} × ${i.qty}`).join('\n');
    const base = storePublicUrl(store);
    const text = [
      `مرحبًا${name ? ` ${name}` : ''} 👋`,
      `لاحظنا أنك تركت سلتك في ${store.name}:`,
      '',
      lines,
      '',
      `المجموع: ${subtotal.toLocaleString('en-US')} ${cur}`,
      `أكمل طلبك من هنا: ${base}`,
      'وإن كان لديك سؤال فنحن هنا 🙏',
    ].join('\n');
    return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  }

  async reminded(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const r = await db.shopCart.updateMany({ where: { id, storeId }, data: { remindedAt: new Date() } });
    if (!r.count) throw new NotFoundException('السلة غير موجودة');
    return { ok: true };
  }

  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    const r = await this.prisma.forTenant(ctx.companyId).shopCart.deleteMany({ where: { id, storeId } });
    if (!r.count) throw new NotFoundException('السلة غير موجودة');
    return { ok: true };
  }
}

@ShopSection('orders')
@PlanFeature('abandonedCarts')
@Controller('shop/stores/:storeId/carts')
export class ShopCartsController {
  constructor(private readonly carts: ShopCartsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Query('status') status?: string) {
    return this.carts.list(ctx, storeId, status === '1' ? CartStatus.Recovered : undefined);
  }

  @Post(':id/reminded')
  reminded(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.carts.reminded(ctx, storeId, id);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.carts.remove(ctx, storeId, id);
  }
}
