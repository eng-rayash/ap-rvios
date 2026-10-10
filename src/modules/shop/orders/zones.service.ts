import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { MAX_ZONES } from '../shop.constants';
import { ZoneDto } from './orders.dto';

/**
 * مناطق التوصيل — رسم واحد لصنعاء وعدن وحضرموت غير قابل للاستخدام: التاجر
 * إمّا يخسر أو يبالغ، وفي الحالتين يترك المنصة.
 */
@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  async list(ctx: TenantContext, storeId: string) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const zones = await db.shopDeliveryZone.findMany({
      where: { storeId },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
    return {
      zones,
      // الرسم العام يظهر معها: هو ما يُطبَّق حين لا مناطق
      fallback: { fee: store.deliveryFee, freeOver: store.deliveryFreeOver },
    };
  }

  async create(ctx: TenantContext, storeId: string, dto: ZoneDto) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('اسم المنطقة مطلوب');

    const count = await db.shopDeliveryZone.count({ where: { storeId } });
    if (count >= MAX_ZONES) throw new BadRequestException('بلغتَ حدّ أربعين منطقة');

    return db.shopDeliveryZone.create({
      data: tenantCreate<Prisma.ShopDeliveryZoneUncheckedCreateInput>({
        storeId,
        name,
        fee: dto.fee ?? 0,
        freeOver: dto.freeOver ?? 0,
        sort: dto.sort ?? count,
      }),
    });
  }

  private async zone(ctx: TenantContext, storeId: string, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const z = await db.shopDeliveryZone.findFirst({ where: { id, storeId } });
    if (!z) throw new NotFoundException('المنطقة غير موجودة');
    return z;
  }

  async update(ctx: TenantContext, storeId: string, id: string, dto: ZoneDto) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.zone(ctx, storeId, id);
    const db = this.prisma.forTenant(ctx.companyId);
    return db.shopDeliveryZone.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.fee !== undefined ? { fee: dto.fee } : {}),
        ...(dto.freeOver !== undefined ? { freeOver: dto.freeOver } : {}),
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
      },
    });
  }

  /** الطلبات القديمة تحتفظ باسم المنطقة نصًّا، فالحذف لا يمحو ما دُفع فعلًا. */
  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.zone(ctx, storeId, id);
    const db = this.prisma.forTenant(ctx.companyId);
    await db.shopDeliveryZone.delete({ where: { id } });
    return { ok: true };
  }
}
