import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { GRACE_DAYS } from '../shop-billing/shop-billing.constants';
import { StoreSubscriptionsService } from '../shop-billing/store-subscriptions.service';
import { MerchantNotifier } from './merchant-notifier.service';

const EVERY_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reminderText(storeName: string, stage: string, daysLeft: number): string {
  if (stage === 'd7') {
    return `تذكير: اشتراك «${storeName}» ينتهي بعد ${daysLeft} أيام.\n\n`
      + 'جدّد من قسم الاشتراك في لوحتك لتبقى متاجرك ومنتجاتك كما هي.';
  }
  if (stage === 'd1') {
    return `اشتراك «${storeName}» ينتهي غدًا.\n\n`
      + 'جدّد اليوم لتفادي إخفاء منتجاتك الزائدة عن حد الباقة المجانية.';
  }
  if (stage === 'grace') {
    return `انتهى اشتراك «${storeName}» — ولديك ${GRACE_DAYS} أيام مهلة.\n\n`
      + 'متجرك وبياناتك كما هي ولم يُحذف شيء. جدّد خلال المهلة ويعود كل شيء فورًا.';
  }
  return `انتهت مهلة اشتراك «${storeName}».\n\n`
    + 'لم نحذف شيئًا — منتجاتك وطلباتك محفوظة بالكامل، وأُخفي ما يتجاوز حد الباقة المجانية فقط. '
    + 'جدّد في أي وقت ويعود كل شيء كما كان.';
}

/**
 * الكنس الدوري لاشتراكات المتاجر: انتقالات الحالة (نشط ← مهلة ← منتهٍ) ثم
 * إشعار التاجر بكل انتقال وتذكير مستحق.
 *
 * كان يعمل في خادم منصة المتاجر القديم بحساب خدمة ينادي الباكند؛ صار هنا
 * لأن المتاجر نفسها هنا. القاعدة كما هي: **فشل الإرسال لا يُسجَّل مُرسَلًا**،
 * فيُعاد التذكير في الكنس التالي بدل أن يضيع عند أول عطل شبكة.
 *
 * `BILLING_WORKER=0` يعطّله (الاختبارات، أو نسخة ثانية من الخادم).
 */
@Injectable()
export class SubscriptionReminders implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionReminders.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly subs: StoreSubscriptionsService,
    private readonly notifier: MerchantNotifier,
  ) {}

  onModuleInit() {
    if (process.env.BILLING_WORKER === '0') return;
    this.logger.log(`إشعارات التجّار: ${this.notifier.status()}`);
    // دقيقة بعد الإقلاع لا فورًا: لا نزاحم الإقلاع ولا الترحيلات
    const first = setTimeout(() => void this.run(), 60_000);
    first.unref?.();
    this.timer = setInterval(() => void this.run(), EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** كنسة واحدة — عامة للاختبار. تعيد عدد ما أُرسل لكل مرحلة. */
  async run() {
    if (this.running) return null;
    this.running = true;
    try {
      const out = await this.subs.sweep();
      const sent: Record<string, number> = { d7: 0, d1: 0, grace: 0, expired: 0 };

      const jobs = [
        ...out.toGrace.map((s) => ({ ...s, stage: 'grace', daysLeft: 0 })),
        ...out.toExpired.map((s) => ({ ...s, stage: 'expired', daysLeft: 0 })),
        ...out.reminders.map((r) => ({ id: r.id, companyId: r.companyId, storeRef: r.storeRef, stage: r.stage, daysLeft: r.daysLeft })),
      ];

      for (const j of jobs) {
        // اشتراكات منصة المتاجر القديمة تحمل معرّفًا رقميًا لا يطابق أي متجر هنا —
        // الاستعلام به على عمود uuid يرمي فيوقف الكنس كله
        if (!UUID.test(j.storeRef ?? '')) continue;
        // المتجر بمعرّفه **وشركته** معًا: اشتراك يتيم من متجر محذوف لا يصل إشعاره لغيره
        const store = await this.prisma.shopStore.findFirst({
          where: { id: j.storeRef, companyId: j.companyId },
          select: { name: true, whatsapp: true },
        });
        if (!store) continue;
        try {
          await this.notifier.notify(store, reminderText(store.name, j.stage, j.daysLeft));
          await this.subs.markNotified(j.id, j.stage);
          sent[j.stage]++;
        } catch (err) {
          this.logger.warn(`تعذّر تذكير «${store.name}» (${j.stage}): ${(err as Error).message}`);
        }
      }

      if (jobs.length) this.logger.log(`كنس الاشتراكات: ${JSON.stringify(sent)}`);
      return sent;
    } catch (err) {
      this.logger.warn(`تعذّر كنس الاشتراكات: ${(err as Error).message}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
