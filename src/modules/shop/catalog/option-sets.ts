import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsString, Length, MaxLength } from 'class-validator';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { ShopSection } from '../../../common/tenant/shop-sections';

export class OptionSetDto {
  @IsString() @Length(1, 24) name!: string;
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(40, { each: true }) values!: string[];
}

const MAX_SETS = 50;

/**
 * خيارات محفوظة (المقاسات، الألوان، السعات…) — يحفظها التاجر مرة ويطبّقها على أي منتج.
 * خاصة باللوحة: لا تُنشر في واجهة المتجر. الحفظ بالاسم نفسه يحدّث القيم.
 */
@Injectable()
export class OptionSetsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  async list(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    return this.prisma.forTenant(ctx.companyId).shopOptionSet.findMany({ where: { storeId }, orderBy: { name: 'asc' } });
  }

  async save(ctx: TenantContext, storeId: string, dto: OptionSetDto) {
    await this.access.require(ctx, storeId, { writable: true });
    const name = dto.name.trim();
    const values = [...new Set(dto.values.map((v) => v.trim()).filter(Boolean))];
    if (!name || !values.length) throw new BadRequestException('اكتب اسم الخيار وقيمه');
    const db = this.prisma.forTenant(ctx.companyId);
    const existing = await db.shopOptionSet.findFirst({ where: { storeId, name } });
    if (existing) return db.shopOptionSet.update({ where: { id: existing.id }, data: { values } });
    if ((await db.shopOptionSet.count({ where: { storeId } })) >= MAX_SETS) throw new BadRequestException(`حدّ الخيارات المحفوظة ${MAX_SETS}`);
    return db.shopOptionSet.create({ data: tenantCreate<Prisma.ShopOptionSetUncheckedCreateInput>({ storeId, name, values }) });
  }

  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const s = await db.shopOptionSet.findFirst({ where: { id, storeId } });
    if (!s) throw new NotFoundException('غير موجود');
    await db.shopOptionSet.delete({ where: { id } });
    return { ok: true };
  }
}

@ShopSection('products')
@Controller('shop/stores/:storeId/option-sets')
export class OptionSetsController {
  constructor(private readonly sets: OptionSetsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.sets.list(ctx, storeId);
  }

  @RequireRole(UserRole.Employee)
  @Post()
  save(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: OptionSetDto) {
    return this.sets.save(ctx, storeId, dto);
  }

  @RequireRole(UserRole.Employee)
  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.sets.remove(ctx, storeId, id);
  }
}
