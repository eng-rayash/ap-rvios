import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import {
  BILLING_CURRENCIES,
  PAYMENT_METHODS,
  SEMVER,
  SETTING_KEYS,
  TEXT_SETTING_PREFIXES,
} from './shop-billing.constants';
import { STORE_TEMPLATES, isTemplate } from '../shop/store-templates';

/**
 * إعدادات المنصة العالمية — أسعار الباقات وتعليمات التحويل.
 *
 * `PlatformSetting` عالمي عمدًا (لا `companyId`)، فالخدمة تستعمل العميل
 * الأساس. القيمة `null` تعني «لم تُحسم» والواجهات تعرض «—» بدل رقم مخترع.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async get<T>(key: string, fallback: T | null = null): Promise<T | null> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    if (!row || row.value === null) return fallback;
    return row.value as T;
  }

  async set(key: string, value: string | number | null): Promise<void> {
    const json = value === null ? Prisma.JsonNull : value;
    await this.prisma.platformSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json },
    });
  }

  /** أسعار الباقات الشهرية بالريال اليمني. */
  async planPrices(): Promise<{ plus: number | null; pro: number | null }> {
    return {
      plus: await this.get<number>('price.plus'),
      pro: await this.get<number>('price.pro'),
    };
  }

  async addonPrices(): Promise<{
    store_build: number | null;
    domain: number | null;
    extra_store: number | null;
  }> {
    return {
      store_build: await this.get<number>('price.store_build'),
      domain: await this.get<number>('price.domain'),
      extra_store: await this.get<number>('price.extra_store'),
    };
  }

  /** عملة الفوترة — الدولار ما لم تضبط الإدارة غيره. */
  async currency(): Promise<string> {
    return (await this.get<string>('billing.currency')) ?? 'USD';
  }

  /**
   * أسعار القوالب المدفوعة: الافتراضي من `STORE_TEMPLATES`، وما ضبطته
   * الإدارة (`tpl.<id>`) يعلوه. المجاني لا يُسعَّر.
   */
  async templatePrices(): Promise<Record<string, number>> {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { startsWith: 'tpl.' } } });
    const set = new Map(rows.map((r) => [r.key.slice(4), r.value]));
    const out: Record<string, number> = {};
    for (const [id, t] of Object.entries(STORE_TEMPLATES)) {
      if (t.tier === 'free') continue;
      const v = Number(set.get(id));
      out[id] = set.has(id) && Number.isFinite(v) && v >= 0 ? v : t.price;
    }
    return out;
  }

  /** شهور مجانية عند الاشتراك السنوي — شهران افتراضيًا. */
  async yearlyMonthsFree(): Promise<number> {
    return (await this.get<number>('billing.yearlyMonthsFree')) ?? 2;
  }

  /** وسائل الدفع التي لها تعليمات فقط — لا نعرض وسيلة بلا تعليمات تحويل. */
  async paymentMethods() {
    const out: Array<{
      id: string;
      name: string;
      scope: string;
      instructions: string;
    }> = [];
    for (const m of PAYMENT_METHODS) {
      const instructions = (await this.get<string>(m.key)) ?? '';
      if (instructions) {
        out.push({ id: m.id, name: m.name, scope: m.scope, instructions });
      }
    }
    return out;
  }

  /** كل الإعدادات لعرضها في لوحة الإدارة. */
  async snapshot() {
    return {
      prices: await this.planPrices(),
      addons: await this.addonPrices(),
      yearlyMonthsFree: await this.yearlyMonthsFree(),
      currency: await this.currency(),
      templates: await this.templatePrices(),
      app: await this.appConfig(),
      methods: await Promise.all(
        PAYMENT_METHODS.map(async (m) => ({
          id: m.id,
          name: m.name,
          scope: m.scope,
          instructions: (await this.get<string>(m.key)) ?? '',
        })),
      ),
    };
  }

  /**
   * إعدادات تطبيق عزم الجوال — عامة بلا مصادقة: يقرؤها التطبيق قبل الدخول
   * ليقرّر هل يعمل أم يطلب التحديث أم يعرض الصيانة. لا شيء فيها سرّي.
   */
  async appConfig() {
    return {
      minVersion: (await this.get<string>('app.minVersion')) ?? '0.0.0',
      latestVersion: (await this.get<string>('app.latestVersion')) ?? null,
      maintenance: (await this.get<number>('app.maintenance')) === 1,
      maintenanceMessage: (await this.get<string>('app.maintenanceMessage')) || null,
      storeUrl: (await this.get<string>('app.storeUrl')) || null,
    };
  }

  /** تحديث مفاتيح مسموحة فقط؛ يعيد ما طُبّق. */
  async update(input: Record<string, unknown>): Promise<string[]> {
    const applied: string[] = [];
    for (const [key, raw] of Object.entries(input)) {
      // سعر قالب مدفوع: `tpl.<id>` — رقم غير سالب، أو فارغ للعودة إلى الافتراضي
      if (key.startsWith('tpl.')) {
        const id = key.slice(4);
        if (!isTemplate(id) || STORE_TEMPLATES[id].tier === 'free') continue;
        if (raw === null || raw === '') {
          await this.prisma.platformSetting.deleteMany({ where: { key } });
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`سعر غير صالح للقالب ${id}`);
          await this.set(key, Math.round(n * 100) / 100);
        }
        applied.push(key);
        continue;
      }
      if (!SETTING_KEYS.has(key)) continue;

      let value: string | number | null;
      if (TEXT_SETTING_PREFIXES.some((p) => key.startsWith(p))) {
        value = String(raw ?? '').slice(0, 600);
        if (key === 'app.storeUrl' && value && !/^https:\/\//.test(value)) {
          throw new BadRequestException('رابط المتجر يجب أن يبدأ بـ https://');
        }
      } else if (key === 'app.minVersion' || key === 'app.latestVersion') {
        value = raw === null || raw === '' ? null : String(raw).trim();
        if (value !== null && !SEMVER.test(value)) {
          throw new BadRequestException(`رقم إصدار غير صالح للمفتاح ${key} — الصيغة 1.2.3`);
        }
      } else if (key === 'billing.currency') {
        value = String(raw ?? '').trim().toUpperCase();
        if (!BILLING_CURRENCIES.has(value)) {
          throw new BadRequestException(`عملة غير مدعومة — ${[...BILLING_CURRENCIES].join(' أو ')}`);
        }
      } else if (key === 'app.maintenance') {
        value = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
      } else if (raw === null || raw === '') {
        value = null;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          throw new BadRequestException(`قيمة غير صالحة للمفتاح ${key}`);
        }
        value = Math.trunc(n);
      }
      await this.set(key, value);
      applied.push(key);
    }
    if (!applied.length) {
      throw new BadRequestException('لا يوجد إعداد صالح للتحديث');
    }
    return applied;
  }
}
