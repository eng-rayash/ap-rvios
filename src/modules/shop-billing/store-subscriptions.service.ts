import { Injectable, NotFoundException } from '@nestjs/common';
import { StoreSubscription } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import {
  GRACE_DAYS,
  MAX_STORE_SLOTS,
  MS_DAY,
  PLAN_CODE,
  REMINDER_STAGES,
  ShopPlan,
  SubStatus,
} from './shop-billing.constants';

/** ما تراه منصة المتاجر عن اشتراك متجر. */
export interface SubscriptionView {
  storeRef: string;
  plan: string;
  status: number;
  currentPeriodEnd: string | null;
  daysLeft: number | null;
  effectivePlan: string;
  graceDays: number;
}

/**
 * دورة حياة اشتراك المتجر — منقولة من `server/billing.js` في منصة المتاجر.
 *
 * تستعمل العميل الأساس بشرط `companyId` صريح في كل استعلام لأنها تُستدعى
 * من مسارين: التاجر (شركته من الجلسة) وفريق المنصة (عبر كل الشركات).
 * الاستدعاءات من جهة التاجر تمرّر `ctx.companyId` دائمًا، لا قيمة من جسم
 * الطلب.
 *
 * المبدأ الحاكم (§٥.٥): الانتهاء تدرّج ناعم — لا حذف ولا إغلاق. المتجر
 * يبقى حيًّا، ويُخفى فقط ما يتجاوز حد الباقة المجانية.
 */
@Injectable()
export class StoreSubscriptionsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** يضمن وجود اشتراك للمتجر (مجاني افتراضيًا). */
  async ensure(
    companyId: string,
    storeRef: string,
    storeName?: string,
  ): Promise<StoreSubscription> {
    const existing = await this.prisma.storeSubscription.findUnique({
      where: { companyId_storeRef: { companyId, storeRef } },
    });

    // اشتراك محذوف ثم عاد المعرّف نفسه (متجر جديد بمعرّف قديم) يبدأ نظيفًا:
    // لا يرث باقة ولا فترة من متجر سبق أن مات.
    if (existing?.deletedAt) {
      return this.prisma.storeSubscription.update({
        where: { id: existing.id },
        data: {
          deletedAt: null,
          plan: ShopPlan.Basic,
          status: SubStatus.Active,
          currentPeriodEnd: null,
          notifiedStage: null,
          notifiedAt: null,
          storeName,
          version: { increment: 1 },
        },
      });
    }
    if (existing) {
      return storeName && storeName !== existing.storeName
        ? this.prisma.storeSubscription.update({
            where: { id: existing.id },
            data: { storeName },
          })
        : existing;
    }
    return this.prisma.storeSubscription.create({
      data: { syncId: randomUUID(), companyId, storeRef, storeName },
    });
  }

  /**
   * حذف ناعم عند حذف المتجر. اشتراك يتيم يُحسب في «المتاجر المسجَّلة»
   * فيمنع سحب خانة بعد رفض إيصالها، ويظهر في لوحة الإدارة لمتجر غير موجود.
   */
  async remove(companyId: string, storeRef: string): Promise<void> {
    await this.prisma.storeSubscription.updateMany({
      where: { companyId, storeRef, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }

  /** ينسخ الباقة والفترة من اشتراك آخر في الشركة نفسها (متجر إضافي). */
  async inherit(
    companyId: string,
    storeRef: string,
    fromRef: string,
  ): Promise<StoreSubscription> {
    const target = await this.ensure(companyId, storeRef);
    const source = await this.prisma.storeSubscription.findUnique({
      where: { companyId_storeRef: { companyId, storeRef: fromRef } },
    });
    if (!source || source.deletedAt) return target;

    return this.prisma.storeSubscription.update({
      where: { id: target.id },
      data: {
        plan: source.plan,
        status: source.status,
        currentPeriodEnd: source.currentPeriodEnd,
        version: { increment: 1 },
      },
    });
  }

  /** الباقة المؤثّرة على الحدود: المنتهي يعود إلى المجانية بلا حذف بيانات. */
  effectivePlan(sub: Pick<StoreSubscription, 'plan' | 'status'>): number {
    if (sub.plan === ShopPlan.Basic) return ShopPlan.Basic;
    return sub.status === SubStatus.Expired ? ShopPlan.Basic : sub.plan;
  }

  view(sub: StoreSubscription): SubscriptionView {
    const end = sub.currentPeriodEnd;
    return {
      storeRef: sub.storeRef,
      plan: PLAN_CODE[sub.plan] ?? 'basic',
      status: sub.status,
      currentPeriodEnd: end ? end.toISOString() : null,
      daysLeft: end ? Math.ceil((end.getTime() - Date.now()) / MS_DAY) : null,
      effectivePlan: PLAN_CODE[this.effectivePlan(sub)] ?? 'basic',
      graceDays: GRACE_DAYS,
    };
  }

  /** يفعّل الباقة ويمدّ الفترة — من نهاية الحالية إن كانت سارية، وإلا من اليوم. */
  async activatePlan(
    companyId: string,
    storeRef: string,
    plan: ShopPlan,
    months: number,
  ): Promise<StoreSubscription> {
    const sub = await this.ensure(companyId, storeRef);

    const base =
      sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > Date.now()
        ? new Date(sub.currentPeriodEnd)
        : new Date();
    base.setMonth(base.getMonth() + Math.max(1, months || 1));

    return this.prisma.storeSubscription.update({
      where: { id: sub.id },
      data: {
        plan,
        status: SubStatus.Active,
        currentPeriodEnd: base,
        notifiedStage: null,
        notifiedAt: null,
        version: { increment: 1 },
      },
    });
  }

  /** خانات المتاجر — عدد المتاجر القائمة يعرفه المتجر، فنعيد ما سُجِّل هنا. */
  async slotsOf(companyId: string) {
    const [org, registered] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: companyId },
        select: { storeSlots: true },
      }),
      this.prisma.storeSubscription.count({
        where: { companyId, deletedAt: null },
      }),
    ]);
    const slots = org?.storeSlots ?? 1;
    return {
      slots,
      registered,
      free: Math.max(0, slots - registered),
      max: MAX_STORE_SLOTS,
    };
  }

  /** رفض الإيصال يسحب التفعيل الذي مُنح قبل المراجعة. */
  async revokePlan(companyId: string, storeRef: string): Promise<void> {
    await this.prisma.storeSubscription.updateMany({
      where: { companyId, storeRef },
      data: {
        plan: ShopPlan.Basic,
        status: SubStatus.Expired,
        version: { increment: 1 },
      },
    });
  }

  /** يمنح خانة متجر إضافي — للحساب لا للمتجر. */
  async grantSlot(companyId: string): Promise<number> {
    const org = await this.prisma.organization.findUnique({
      where: { id: companyId },
      select: { storeSlots: true },
    });
    if (!org) throw new NotFoundException('الشركة غير موجودة');
    const next = Math.min(MAX_STORE_SLOTS, org.storeSlots + 1);
    await this.prisma.organization.update({
      where: { id: companyId },
      data: { storeSlots: next },
    });
    return next;
  }

  /**
   * يسحب خانة عند رفض الإيصال.
   *
   * لا ينزل تحت `ownedStores` إن عُرف: الرفض يمنع متجرًا جديدًا ولا
   * يحذف قائمًا — بيانات التاجر لا تُمس بقرار فوترة. عدد المتاجر القائمة
   * يعيش عند منصة المتاجر، فنستنتج حدًّا أدنى من الاشتراكات المسجَّلة هنا.
   */
  async revokeSlot(companyId: string): Promise<number> {
    const [org, registered] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: companyId },
        select: { storeSlots: true },
      }),
      this.prisma.storeSubscription.count({
        where: { companyId, deletedAt: null },
      }),
    ]);
    if (!org) throw new NotFoundException('الشركة غير موجودة');
    const next = Math.max(1, registered, org.storeSlots - 1);
    await this.prisma.organization.update({
      where: { id: companyId },
      data: { storeSlots: next },
    });
    return next;
  }

  /**
   * الكنس الدوري: نشط ← مهلة ← منتهٍ، ويعيد التذكيرات المستحقة.
   *
   * تغيير الحالة في القاعدة هو الحقيقة؛ الإشعار تحسين. لذلك لا يُرسل من
   * هنا — المنصة تعيد ما يجب إخطاره، ومنصة المتاجر ترسله (واتساب) ثم
   * تؤكّد عبر [markNotified]. فشل الإرسال لا يُسجَّل مُرسَلًا، فلا يضيع
   * التذكير عند أول عطل شبكة.
   */
  async sweep() {
    const now = new Date();
    const graceCutoff = new Date(now.getTime() - GRACE_DAYS * MS_DAY);

    const due = await this.prisma.storeSubscription.findMany({
      where: {
        plan: { not: ShopPlan.Basic },
        status: SubStatus.Active,
        currentPeriodEnd: { lt: now },
        deletedAt: null,
      },
    });
    for (const sub of due) {
      await this.prisma.storeSubscription.update({
        where: { id: sub.id },
        data: { status: SubStatus.Grace, version: { increment: 1 } },
      });
    }

    const overdue = await this.prisma.storeSubscription.findMany({
      where: {
        status: SubStatus.Grace,
        currentPeriodEnd: { lt: graceCutoff },
        deletedAt: null,
      },
    });
    for (const sub of overdue) {
      await this.prisma.storeSubscription.update({
        where: { id: sub.id },
        data: { status: SubStatus.Expired, version: { increment: 1 } },
      });
    }

    return {
      toGrace: due.map((s) => ({ id: s.id, companyId: s.companyId, storeRef: s.storeRef })),
      toExpired: overdue.map((s) => ({ id: s.id, companyId: s.companyId, storeRef: s.storeRef })),
      reminders: await this.dueReminders(now),
    };
  }

  /** التذكيرات المستحقة ولم تُرسَل بعد — لا تُعلَّم مُرسَلة هنا. */
  private async dueReminders(now: Date) {
    const out: Array<{
      id: string;
      companyId: string;
      storeRef: string;
      storeName: string | null;
      stage: string;
      daysLeft: number;
    }> = [];

    // من الأقرب انتهاءً: d1 قبل d7، فلا يتلقّى المشترك مرحلة أقدم منها.
    const seen = new Set<string>();
    for (const { key, days } of [...REMINDER_STAGES].reverse()) {
      const until = new Date(now.getTime() + days * MS_DAY);
      const laterStages = REMINDER_STAGES.slice(
        REMINDER_STAGES.findIndex((s) => s.key === key),
      ).map((s) => s.key as string);

      const rows = await this.prisma.storeSubscription.findMany({
        where: {
          plan: { not: ShopPlan.Basic },
          status: SubStatus.Active,
          currentPeriodEnd: { lte: until, gt: now },
          deletedAt: null,
          OR: [
            { notifiedStage: null },
            { notifiedStage: { notIn: laterStages } },
          ],
        },
      });
      for (const s of rows) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        out.push({
          id: s.id,
          companyId: s.companyId,
          storeRef: s.storeRef,
          storeName: s.storeName,
          stage: key,
          daysLeft: Math.max(
            1,
            Math.ceil((s.currentPeriodEnd!.getTime() - now.getTime()) / MS_DAY),
          ),
        });
      }
    }
    return out;
  }

  async markNotified(id: string, stage: string) {
    const sub = await this.prisma.storeSubscription.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException('الاشتراك غير موجود');
    return this.prisma.storeSubscription.update({
      where: { id },
      data: { notifiedStage: stage, notifiedAt: new Date() },
    });
  }
}
