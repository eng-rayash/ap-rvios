import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { Prisma, ShopStore } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { StorefrontCache } from '../public/storefront-cache.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { SOLD_STATUSES } from '../shop.constants';

export const SECTION_SOURCES = ['best', 'new', 'sale', 'category', 'brand', 'manual'] as const;
export type SectionSource = (typeof SECTION_SOURCES)[number];

export class SectionDto {
  @IsOptional() @IsString() @MaxLength(60) title?: string;
  @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @IsOptional() @IsIn(SECTION_SOURCES as unknown as string[]) source?: SectionSource;
  /** معرّف التصنيف أو اسم العلامة التجارية */
  @IsOptional() @IsString() @MaxLength(80) ref?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(24) @IsUUID('all', { each: true }) productIds?: string[];
  @IsOptional() @IsIn(['grid', 'row']) layout?: string;
  @IsOptional() @IsInt() @Min(2) @Max(24) limit?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ReorderDto {
  @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) ids!: string[];
}

const MAX_SECTIONS = 12;

/**
 * أقسام منتجات للصفحة الرئيسية (الأكثر مبيعًا، الأحدث، العروض، تصنيف، علامة، اختيار يدوي) —
 * تظهر تحت تصميم أي قالب ببطاقة القالب نفسه. المنتجات تُحسب في الخادم من بيانات المتجر الحقيقية.
 */
@Injectable()
export class ShopSectionsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly cache: StorefrontCache,
  ) {}

  async list(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    return this.prisma.forTenant(ctx.companyId).shopSection.findMany({ where: { storeId }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
  }

  private shape(dto: SectionDto) {
    return {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle.trim() } : {}),
      ...(dto.source !== undefined ? { source: dto.source } : {}),
      ...(dto.ref !== undefined ? { ref: dto.ref.trim() } : {}),
      ...(dto.productIds !== undefined ? { productIds: [...new Set(dto.productIds)] } : {}),
      ...(dto.layout !== undefined ? { layout: dto.layout } : {}),
      ...(dto.limit !== undefined ? { limit: dto.limit } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    };
  }

  private check(source: string, ref: string, productIds: string[]) {
    if ((source === 'category' || source === 'brand') && !ref) throw new BadRequestException(source === 'category' ? 'اختر التصنيف' : 'اختر العلامة التجارية');
    if (source === 'manual' && !productIds.length) throw new BadRequestException('اختر المنتجات');
  }

  async create(ctx: TenantContext, storeId: string, dto: SectionDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const count = await db.shopSection.count({ where: { storeId } });
    if (count >= MAX_SECTIONS) throw new BadRequestException(`حدّ الأقسام ${MAX_SECTIONS}`);
    const data = { source: 'best', ref: '', productIds: [] as string[], ...this.shape(dto) };
    if (!data.title) throw new BadRequestException('اكتب عنوان القسم');
    this.check(data.source, data.ref, data.productIds);
    const s = await db.shopSection.create({ data: tenantCreate<Prisma.ShopSectionUncheckedCreateInput>({ storeId, sort: count, ...data, title: data.title }) });
    this.cache.purge(store.slug);
    return s;
  }

  async update(ctx: TenantContext, storeId: string, id: string, dto: SectionDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const cur = await db.shopSection.findFirst({ where: { id, storeId } });
    if (!cur) throw new NotFoundException('القسم غير موجود');
    const next = { ...cur, ...this.shape(dto) };
    this.check(next.source, next.ref, next.productIds);
    const s = await db.shopSection.update({ where: { id }, data: this.shape(dto) });
    this.cache.purge(store.slug);
    return s;
  }

  async reorder(ctx: TenantContext, storeId: string, ids: string[]) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    await this.prisma.$transaction(ids.map((id, i) => db.shopSection.updateMany({ where: { id, storeId }, data: { sort: i } })));
    this.cache.purge(store.slug);
    return this.list(ctx, storeId);
  }

  async remove(ctx: TenantContext, storeId: string, id: string) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const r = await db.shopSection.deleteMany({ where: { id, storeId } });
    if (!r.count) throw new NotFoundException('القسم غير موجود');
    this.cache.purge(store.slug);
    return { ok: true };
  }

  // ═══ واجهة المتجر ═════════════════════════════════════════

  /**
   * الأقسام المفعّلة بمعرّفات منتجاتها (المعروضة فقط، ضمن `visible` حدّ الباقة إن وُجد).
   * قسم بلا منتجات لا يُرسل — لا عنوان فوق فراغ.
   */
  async resolve(store: ShopStore, visible: string[] | null, parentOf: Map<string, string | null>) {
    const sections = await this.prisma.shopSection.findMany({ where: { storeId: store.id, active: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
    if (!sections.length) return [];
    const base: Prisma.ShopProductWhereInput = { storeId: store.id, live: true, ...(visible ? { id: { in: visible } } : {}) };
    const out: { id: string; title: string; subtitle: string; layout: string; source: string; ref: string; productIds: string[] }[] = [];
    for (const s of sections) {
      const take = s.limit;
      let ids: string[] = [];
      if (s.source === 'best') {
        const rows = await this.prisma.shopOrderItem.groupBy({
          by: ['productId'],
          where: { storeId: store.id, productId: { not: null }, order: { createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) }, status: { in: SOLD_STATUSES } } },
          _sum: { qty: true },
          orderBy: { _sum: { qty: 'desc' } },
          take: take * 2,
        });
        const sold = rows.map((r) => r.productId!).filter(Boolean);
        const live = new Set((await this.prisma.shopProduct.findMany({ where: { ...base, id: { in: sold } }, select: { id: true } })).map((p) => p.id));
        ids = sold.filter((x) => live.has(x)).slice(0, take);
      } else if (s.source === 'sale') {
        const rows = await this.prisma.shopProduct.findMany({ where: { ...base, oldPrice: { not: null } }, select: { id: true, price: true, oldPrice: true }, orderBy: { createdAt: 'desc' } });
        ids = rows.filter((p) => (p.oldPrice ?? 0) > p.price).slice(0, take).map((p) => p.id);
      } else if (s.source === 'category') {
        // التصنيف وفروعه
        const cats = [s.ref, ...[...parentOf.entries()].filter(([, parent]) => parent === s.ref).map(([id]) => id)];
        ids = (await this.prisma.shopProduct.findMany({ where: { ...base, categoryId: { in: cats } }, select: { id: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], take })).map((p) => p.id);
      } else if (s.source === 'brand') {
        ids = (await this.prisma.shopProduct.findMany({ where: { ...base, brand: s.ref }, select: { id: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], take })).map((p) => p.id);
      } else if (s.source === 'manual') {
        const live = new Set((await this.prisma.shopProduct.findMany({ where: { ...base, id: { in: s.productIds } }, select: { id: true } })).map((p) => p.id));
        ids = s.productIds.filter((x) => live.has(x)).slice(0, take);
      } else {
        ids = (await this.prisma.shopProduct.findMany({ where: base, select: { id: true }, orderBy: { createdAt: 'desc' }, take })).map((p) => p.id);
      }
      if (ids.length) out.push({ id: s.id, title: s.title, subtitle: s.subtitle, layout: s.layout, source: s.source, ref: s.ref, productIds: ids });
    }
    return out;
  }
}

@Controller('shop/stores/:storeId/sections')
export class ShopSectionsController {
  constructor(private readonly sections: ShopSectionsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.sections.list(ctx, storeId);
  }

  @RequireRole(UserRole.Employee)
  @Post()
  create(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: SectionDto) {
    return this.sections.create(ctx, storeId, dto);
  }

  @RequireRole(UserRole.Employee)
  @Post('reorder')
  reorder(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: ReorderDto) {
    return this.sections.reorder(ctx, storeId, dto.ids);
  }

  @RequireRole(UserRole.Employee)
  @Patch(':id')
  update(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SectionDto) {
    return this.sections.update(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.Employee)
  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.sections.remove(ctx, storeId, id);
  }
}
