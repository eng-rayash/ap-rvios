import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { ShopSection } from '../../../common/tenant/shop-sections';
import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { OrderStatus } from '../shop.constants';
import { StorefrontCache } from '../public/storefront-cache.service';
import { PlanFeature } from '../plan-feature.guard';

/** رابط تتبّع بصيغة https يحمل {n} مكان رقم الشحنة — مثل https://carrier.example/track?no={n} */
const TRACK_URL = /^https:\/\/[^\s]+$/;

export class CarrierDto {
  @IsString() @Length(2, 60) name!: string;
  @IsOptional() @ValidateIf((_, v) => v !== '') @IsString() @MaxLength(300) @Matches(TRACK_URL, { message: 'رابط التتبّع يبدأ بـ https://' }) trackUrl?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateCarrierDto {
  @IsOptional() @IsString() @Length(2, 60) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== '') @IsString() @MaxLength(300) @Matches(TRACK_URL, { message: 'رابط التتبّع يبدأ بـ https://' }) trackUrl?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class OrderShippingDto {
  /** شركة من قائمة المتجر — null يمسح الشركة */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() carrierId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) trackingNo?: string;
}

/** رابط التتبّع النهائي: {n} يُستبدل برقم الشحنة، ورابط بلا {n} يُعرض كما هو */
export function trackLink(template: string, no: string) {
  if (!template) return '';
  return template.includes('{n}') ? (no ? template.replaceAll('{n}', encodeURIComponent(no)) : '') : template;
}

/**
 * شركات الشحن ورقم التتبّع: التاجر يحفظ شركاته مرة (اسم ورابط تتبّع)، ويختار الشركة ويكتب رقم
 * الشحنة عند الشحن، فيرى العميل الشركة والرقم وزر «تتبّع الشحنة» في صفحة طلبه.
 */
@Injectable()
export class ShopCarriersService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly cache: StorefrontCache,
  ) {}

  async list(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const [carriers, used] = await Promise.all([
      db.shopCarrier.findMany({ where: { storeId }, orderBy: [{ active: 'desc' }, { createdAt: 'asc' }] }),
      db.shopOrder.groupBy({ by: ['carrierName'], where: { storeId, carrierName: { not: '' } }, _count: { _all: true } }),
    ]);
    const n = new Map(used.map((u) => [u.carrierName, u._count._all]));
    return { carriers: carriers.map((c) => ({ ...c, orders: n.get(c.name) ?? 0 })) };
  }

  async create(ctx: TenantContext, storeId: string, dto: CarrierDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    if ((await db.shopCarrier.count({ where: { storeId } })) >= 30) throw new BadRequestException('حدّ شركات الشحن ٣٠ شركة');
    return db.shopCarrier.create({
      data: { companyId: store.companyId, storeId, name: dto.name.trim(), trackUrl: (dto.trackUrl ?? '').trim(), phone: (dto.phone ?? '').trim(), active: dto.active ?? true },
    });
  }

  private async one(ctx: TenantContext, storeId: string, id: string) {
    const c = await this.prisma.forTenant(ctx.companyId).shopCarrier.findFirst({ where: { id, storeId } });
    if (!c) throw new NotFoundException('شركة الشحن غير موجودة');
    return c;
  }

  async update(ctx: TenantContext, storeId: string, id: string, dto: UpdateCarrierDto) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.one(ctx, storeId, id);
    return this.prisma.forTenant(ctx.companyId).shopCarrier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.trackUrl !== undefined && { trackUrl: dto.trackUrl.trim() }),
        ...(dto.phone !== undefined && { phone: dto.phone.trim() }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
  }

  /** الطلبات المشحونة تحتفظ باسم الشركة ورابطها — الحذف لا يمسّها */
  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.one(ctx, storeId, id);
    await this.prisma.forTenant(ctx.companyId).shopCarrier.delete({ where: { id } });
    return { ok: true };
  }

  async setOrderShipping(ctx: TenantContext, storeId: string, orderId: string, dto: OrderShippingDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const o = await db.shopOrder.findFirst({ where: { id: orderId, storeId } });
    if (!o) throw new NotFoundException('الطلب غير موجود');
    if (o.status === OrderStatus.Off || o.status === OrderStatus.Wait) throw new BadRequestException('أكّد الطلب أولًا — الشحن بعد التأكيد');
    const carrier = dto.carrierId ? await this.one(ctx, storeId, dto.carrierId) : dto.carrierId === null ? null : undefined;
    const name = carrier === undefined ? o.carrierName : carrier?.name ?? '';
    const no = dto.trackingNo !== undefined ? dto.trackingNo.trim() : o.trackingNo;
    const template = carrier === undefined ? null : carrier?.trackUrl ?? '';
    const updated = await db.shopOrder.update({
      where: { id: orderId },
      data: {
        carrierName: name,
        trackingNo: no,
        // الرابط يُحسب مع كل تغيير: الشركة الجديدة أو الرقم الجديد
        trackUrl: template === null ? (o.trackUrlTemplate ? trackLink(o.trackUrlTemplate, no) : o.trackUrl) : trackLink(template, no),
        ...(template !== null && { trackUrlTemplate: template }),
      },
      select: { id: true, carrierName: true, trackingNo: true, trackUrl: true },
    });
    this.cache.purge(store.slug);
    return updated;
  }
}

@PlanFeature('carriers')
@Controller('shop/stores/:storeId')
export class ShopCarriersController {
  constructor(private readonly carriers: ShopCarriersService) {}

  @Get('carriers')
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.carriers.list(ctx, storeId);
  }

  @RequireRole(UserRole.DeptManager)
  @Post('carriers')
  create(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: CarrierDto) {
    return this.carriers.create(ctx, storeId, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Patch('carriers/:id')
  update(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCarrierDto) {
    return this.carriers.update(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete('carriers/:id')
  remove(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.carriers.remove(ctx, storeId, id);
  }

  @RequireRole(UserRole.Employee)
  @ShopSection('orders')
  @Patch('orders/:id/shipping')
  shipping(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderShippingDto) {
    return this.carriers.setOrderShipping(ctx, storeId, id, dto);
  }
}
