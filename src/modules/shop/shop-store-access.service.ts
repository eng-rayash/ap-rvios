import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ShopStore } from '@prisma/client';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { StoreSubscriptionsService } from '../shop-billing/store-subscriptions.service';
import { PlanLimits, StoreStatus, limitsOf } from './shop.constants';

/** متجر مُحقَّق الملكية ومعه باقته الفعّالة وحدودها. */
export interface StoreAccess {
  store: ShopStore;
  /** basic | plus | pro — بعد اعتبار الانتهاء (المنتهي يعود إلى basic) */
  plan: string;
  limits: PlanLimits;
}

/**
 * بوّابة الوصول إلى متجر — العزل داخل الشركة الواحدة.
 *
 * `forTenant` يعزل شركة عن شركة، لكن الشركة الواحدة قد تملك عدة متاجر
 * (حتى خمسة). كل خدمة تلمس بيانات متجر تمرّ من هنا أولًا: يُجلب المتجر
 * عبر `forTenant` (فمتجر شركة أخرى غير موجود من منظور الطالب)، ثم تُقرأ
 * الباقة من الاشتراك لا من عمود مخبّأ — الحقيقة واحدة.
 */
@Injectable()
export class ShopStoreAccessService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly subs: StoreSubscriptionsService,
  ) {}

  /** الباقة الفعّالة لمتجر (تنشئ اشتراكًا مجانيًا إن غاب). */
  async planOf(companyId: string, storeId: string): Promise<string> {
    const sub = await this.subs.ensure(companyId, storeId);
    return this.subs.view(sub).effectivePlan;
  }

  /**
   * يجلب متجرًا للتاجر. `writable` يرفض المتجر الموقوف: الإيقاف قرار
   * الإدارة، وتاجر موقوف لا يعدّل متجره حتى تُرفع الملاحظة.
   */
  async require(
    ctx: TenantContext,
    storeId: string,
    { writable = false }: { writable?: boolean } = {},
  ): Promise<StoreAccess> {
    const db = this.prisma.forTenant(ctx.companyId);
    const store = await db.shopStore.findFirst({ where: { id: storeId } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    if (writable && store.status === StoreStatus.Suspended) {
      throw new ForbiddenException('هذا المتجر موقوف — تواصل مع الدعم');
    }
    const plan = await this.planOf(ctx.companyId, store.id);
    return { store, plan, limits: limitsOf(plan) };
  }
}
