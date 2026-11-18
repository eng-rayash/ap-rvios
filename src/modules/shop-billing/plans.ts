import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import type { PlanLimits } from '../shop/shop.constants';

/**
 * الباقات الأربع — مصدر واحد للأسعار والحدود والمزايا.
 *
 * تُحفظ في إعدادات المنصة (`plans.config`) وتعدّلها الإدارة من «الباقات» دون نشر كود؛
 * وما لم يُحفظ يأخذ القيم الافتراضية هنا. الخادم يحكم بها: كل وحدة مقفلة تحمل
 * `@PlanFeature(...)`، والحدود (المنتجات، الصور…) تُقرأ من هنا.
 *
 * التسعير بالريال اليمني ولكل فترة اشتراك سعرها (٣ / ٦ / ١٢ شهرًا افتراضيًا).
 */

export const PLAN_CODES = ['basic', 'plus', 'pro', 'max'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** المزايا التي تُفتح وتُقفل بالباقة — المفتاح ثابت، والاسم للعرض */
export const PLAN_FEATURES = {
  onlinePayments: { label: 'الدفع الإلكتروني والتحويل', group: 'البيع', hint: 'المحافظ والتحويل البنكي بإيصال — المجانية بالدفع عند الاستلام' },
  manualOrders: { label: 'الطلبات اليدوية', group: 'البيع', hint: 'تسجيل طلب الهاتف وواتساب والمحل' },
  returns: { label: 'المرتجعات', group: 'البيع', hint: 'طلبات الاسترجاع وإتمامها' },
  abandonedCarts: { label: 'السلات المتروكة', group: 'البيع', hint: 'تذكير من لم يُكمل طلبه' },
  carriers: { label: 'شركات الشحن وأرقام التتبّع', group: 'البيع', hint: 'رقم الشحنة وزر التتبّع للعميل' },
  wholesale: { label: 'وضع الجملة (بلا أسعار)', group: 'البيع', hint: 'يتصفح العميل ويطلب الكميات دون رؤية الأسعار' },
  customDomain: { label: 'النطاق الخاص', group: 'المتجر', hint: 'متجرك على نطاقك (example.com)' },
  removeBadge: { label: 'إخفاء شارة RVIOS', group: 'المتجر', hint: 'بلا «أُنشئ بواسطة RVIOS» في متجرك' },
  pixels: { label: 'بكسلات الإعلانات وأدوات التحليل', group: 'التسويق', hint: 'Meta وTikTok وSnap وGoogle' },
  loyalty: { label: 'برنامج المكافآت', group: 'التسويق', hint: 'نسبة من كل طلب رصيدًا للعميل' },
  customerAccounts: { label: 'حسابات العملاء ومحافظهم', group: 'التسويق', hint: 'الدخول برمز الجوال والمحفظة والإشعارات' },
  broadcasts: { label: 'الإشعارات الجماعية للعملاء', group: 'التسويق', hint: 'عرض أو خبر لكل عملائك' },
  storeAI: { label: 'المساعد الذكي للمتسوّقين', group: 'الذكاء الاصطناعي', hint: 'مساعد في متجرك يساعد العميل على اختيار المنتج' },
  merchantAI: { label: 'RVIOS AI للتاجر', group: 'الذكاء الاصطناعي', hint: 'كتابة الأوصاف والأفكار والتحليل' },
  advancedReports: { label: 'التقارير المفصّلة وتقرير الزوار', group: 'التقارير', hint: 'فترة مخصّصة ومقارنة وتصدير' },
  staffSections: { label: 'صلاحيات الموظفين بالأقسام', group: 'الفريق', hint: 'ما يراه كل موظف من المتجر' },
} as const;
export type FeatureKey = keyof typeof PLAN_FEATURES;
export const FEATURE_KEYS = Object.keys(PLAN_FEATURES) as FeatureKey[];

export interface PlanConfig {
  name: string;
  tagline: string;
  /** يُبرز في صفحة الباقات «الأكثر اختيارًا» */
  highlight: boolean;
  /** الأشهر ← السعر بالريال (المجانية فارغة) */
  prices: Record<string, number>;
  limits: PlanLimits;
  features: Record<FeatureKey, boolean>;
}
export interface PlansConfig {
  currency: string;
  /** فترات الاشتراك المعروضة بالأشهر */
  periods: number[];
  plans: Record<PlanCode, PlanConfig>;
}

const on = (...keys: FeatureKey[]) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, keys.includes(k)])) as Record<FeatureKey, boolean>;
const GROWTH: FeatureKey[] = ['onlinePayments', 'manualOrders', 'returns', 'abandonedCarts', 'carriers', 'customDomain', 'removeBadge', 'pixels', 'merchantAI'];
const PRO: FeatureKey[] = [...GROWTH, 'loyalty', 'customerAccounts', 'broadcasts', 'advancedReports', 'staffSections', 'storeAI'];

export const DEFAULT_PLANS: PlansConfig = {
  currency: 'YER',
  periods: [3, 6, 12],
  plans: {
    basic: {
      name: 'المجانية', tagline: 'جرّب البيع أونلاين بلا تكلفة', highlight: false, prices: {},
      limits: { products: 20, imagesPerProduct: 2, variantsPerProduct: 5, subcategories: false, extraThemes: false, coupons: 3 },
      features: on(),
    },
    plus: {
      name: 'النمو', tagline: 'لمتجر يبيع كل يوم', highlight: false, prices: { 3: 30_000, 6: 54_000, 12: 96_000 },
      limits: { products: 300, imagesPerProduct: 5, variantsPerProduct: 30, subcategories: true, extraThemes: false, coupons: 10 },
      features: on(...GROWTH),
    },
    pro: {
      name: 'الاحترافية', tagline: 'كل أدوات التسويق والولاء', highlight: true, prices: { 3: 60_000, 6: 108_000, 12: 192_000 },
      limits: { products: 3000, imagesPerProduct: 8, variantsPerProduct: 100, subcategories: true, extraThemes: true, coupons: null },
      features: on(...PRO),
    },
    max: {
      name: 'الأعمال', tagline: 'للعلامات الكبيرة وتجّار الجملة', highlight: false, prices: { 3: 120_000, 6: 216_000, 12: 384_000 },
      limits: { products: null, imagesPerProduct: 12, variantsPerProduct: null, subcategories: true, extraThemes: true, coupons: null },
      features: on(...PRO, 'wholesale'),
    },
  },
};

const KEY = 'plans.config';
let current: PlansConfig = DEFAULT_PLANS;

/** الإعداد الحالي (متزامن) — يُحدَّث من القاعدة كل دقيقة وعند حفظ الإدارة */
export const plansConfig = (): PlansConfig => current;
export const planOf = (code: string): PlanConfig => current.plans[code as PlanCode] ?? current.plans.basic;
export const featuresOf = (code: string) => planOf(code).features;
export const hasFeature = (code: string, f: FeatureKey) => planOf(code).features[f] === true;
/** أدنى باقة فيها الميزة — لرسالة «متاحة من باقة …» */
export const minPlanFor = (f: FeatureKey): PlanCode | null => PLAN_CODES.find((c) => current.plans[c].features[f]) ?? null;

/** يدمج المحفوظ فوق الافتراضي ويتحقق منه — ما لا يُفهم يُتجاهل بدل أن يكسر الفوترة */
export function normalizePlans(raw: unknown): PlansConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlansConfig>;
  const periods = [...new Set((Array.isArray(r.periods) ? r.periods : DEFAULT_PLANS.periods).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 24))]
    .sort((a, b) => a - b)
    .slice(0, 4);
  if (!periods.length) throw new BadRequestException('حدّد فترة اشتراك واحدة على الأقل');
  const lim = (v: unknown, d: number | null) => (v === null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const plans = {} as Record<PlanCode, PlanConfig>;
  for (const code of PLAN_CODES) {
    const d = DEFAULT_PLANS.plans[code];
    const p = ((r.plans as Record<string, Partial<PlanConfig>> | undefined)?.[code] ?? {}) as Partial<PlanConfig>;
    const l = (p.limits ?? {}) as Partial<PlanLimits>;
    const prices: Record<string, number> = {};
    if (code !== 'basic') {
      for (const m of periods) {
        const v = Number((p.prices ?? d.prices)[m] ?? d.prices[m]);
        if (Number.isInteger(v) && v > 0) prices[m] = v;
      }
    }
    plans[code] = {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 30) : d.name,
      tagline: typeof p.tagline === 'string' ? p.tagline.trim().slice(0, 80) : d.tagline,
      highlight: typeof p.highlight === 'boolean' ? p.highlight : d.highlight,
      prices,
      limits: {
        products: lim(l.products, d.limits.products),
        imagesPerProduct: lim(l.imagesPerProduct, d.limits.imagesPerProduct) ?? 1,
        variantsPerProduct: lim(l.variantsPerProduct, d.limits.variantsPerProduct),
        subcategories: typeof l.subcategories === 'boolean' ? l.subcategories : d.limits.subcategories,
        extraThemes: typeof l.extraThemes === 'boolean' ? l.extraThemes : d.limits.extraThemes,
        coupons: lim(l.coupons, d.limits.coupons),
      },
      features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, typeof p.features?.[k] === 'boolean' ? p.features[k] : d.features[k]])) as Record<FeatureKey, boolean>,
    };
  }
  return { currency: typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : DEFAULT_PLANS.currency, periods, plans };
}

@Injectable()
export class PlansService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Plans');
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: TenantPrismaService) {}

  async onModuleInit() {
    await this.reload();
    // أكثر من نسخة للخادم: كل نسخة تلتقط تعديل الإدارة خلال دقيقة
    this.timer = setInterval(() => void this.reload(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reload() {
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: KEY } });
      current = row?.value ? normalizePlans(row.value) : DEFAULT_PLANS;
    } catch (e) {
      this.log.warn(`قراءة الباقات: ${(e as Error).message}`);
    }
    return current;
  }

  async save(raw: unknown) {
    const cfg = normalizePlans(raw);
    await this.prisma.platformSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: cfg as unknown as Prisma.InputJsonValue },
      update: { value: cfg as unknown as Prisma.InputJsonValue },
    });
    current = cfg;
    return cfg;
  }

  async reset() {
    await this.prisma.platformSetting.deleteMany({ where: { key: KEY } });
    current = DEFAULT_PLANS;
    return current;
  }

  /** للعرض: الإعداد ومعه أسماء المزايا ومجموعاتها */
  catalog() {
    return { ...current, features: PLAN_FEATURES, order: PLAN_CODES };
  }
}
