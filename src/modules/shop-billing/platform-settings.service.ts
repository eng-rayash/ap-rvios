import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import {
  BILLING_CURRENCIES,
  DEFAULT_PAY_ACCOUNTS,
  PAY_PROVIDERS,
  PAYMENT_METHODS,
  type PayAccount,
  type PayProvider,
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

  /**
   * حسابات الاستلام (بنوك ومحافظ) — ما ضبطته الإدارة وإلا الافتراضي.
   * `all` للوحة الإدارة، والعامة ترى المفعَّل فقط.
   */
  async payAccounts(all = false) {
    const saved = await this.get<PayAccount[]>('pay.accounts');
    const list = Array.isArray(saved) ? saved : DEFAULT_PAY_ACCOUNTS;
    return list
      .filter((a) => all || a.enabled)
      .map((a) => {
        const p = PAY_PROVIDERS[a.provider] ?? PAY_PROVIDERS.other;
        return { ...a, providerName: p.name, providerNameEn: p.nameEn, kind: p.kind, color: p.color };
      });
  }

  /** يتحقق من قائمة الحسابات ويحفظها كاملة (الترتيب ترتيب العرض)؛ `null` يعيد الافتراضي. */
  private async savePayAccounts(raw: unknown): Promise<void> {
    if (raw === null) {
      await this.prisma.platformSetting.deleteMany({ where: { key: 'pay.accounts' } });
      return;
    }
    if (!Array.isArray(raw) || raw.length > 20) throw new BadRequestException('قائمة الحسابات غير صالحة');
    const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const seen = new Set<string>();
    const list: PayAccount[] = raw.map((r, i) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const provider = str(o.provider, 20) as PayProvider;
      if (!(provider in PAY_PROVIDERS)) throw new BadRequestException(`مزوّد غير معروف في الحساب ${i + 1}`);
      let id = str(o.id, 40).replace(/[^a-z0-9-]/gi, '').toLowerCase() || `${provider}-${i + 1}`;
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      const number = str(o.number, 60);
      const qr = str(o.qr, 600);
      if (qr && !/^https:\/\//.test(qr) && !/^\/pay\/[\w.-]+$/.test(qr)) {
        throw new BadRequestException(`رابط رمز QR غير صالح في الحساب ${i + 1}`);
      }
      if (!number && !qr) throw new BadRequestException(`الحساب ${i + 1} يحتاج رقمًا أو رمز QR`);
      const currency = str(o.currency, 3).toUpperCase();
      return {
        id,
        provider,
        number,
        qr,
        title: str(o.title, 80) || PAY_PROVIDERS[provider].name,
        holder: str(o.holder, 80),
        currency: (['YER', 'USD', 'SAR'].includes(currency) ? currency : '') as PayAccount['currency'],
        note: str(o.note, 300),
        enabled: o.enabled !== false,
      };
    });
    const value = list as unknown as Prisma.InputJsonValue;
    await this.prisma.platformSetting.upsert({
      where: { key: 'pay.accounts' },
      create: { key: 'pay.accounts', value },
      update: { value },
    });
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
      accounts: await this.payAccounts(true),
      notify: {
        emails: (await this.get<string>('notify.emails')) ?? '',
        whatsapp: (await this.get<string>('notify.whatsapp')) ?? '',
      },
      providers: Object.entries(PAY_PROVIDERS).map(([id, p]) => ({ id, ...p })),
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
      if (key === 'pay.accounts') {
        await this.savePayAccounts(raw);
        applied.push(key);
        continue;
      }
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
