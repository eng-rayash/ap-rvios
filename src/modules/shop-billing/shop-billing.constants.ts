/**
 * فوترة منصة المتاجر — الثوابت.
 *
 * أرقام لا نصوص، على عادة بقية المخطط (لا enums في Prisma). ⚠ الأرقام عقد
 * تخزين: صفوف `store_subscriptions` و`platform_invoices` تحملها.
 */

/**
 * 0=مجانية · 1=احترافية · 2=أعمال — رموزها في التخزين `basic|plus|pro`، وفي
 * واجهة منصة المتاجر الجديدة `free|pro|biz` (انظر `PUBLIC_PLAN`).
 */
export enum ShopPlan {
  Basic = 0,
  Plus = 1,
  Pro = 2,
}

export const PLAN_BY_CODE: Record<string, ShopPlan> = {
  basic: ShopPlan.Basic,
  plus: ShopPlan.Plus,
  pro: ShopPlan.Pro,
};

export const PLAN_CODE = ['basic', 'plus', 'pro'] as const;

/** رموز الباقات كما تعرضها منصة المتاجر الجديدة (rvios-next) */
export const PUBLIC_PLAN: Record<ShopPlan, 'free' | 'pro' | 'biz'> = {
  [ShopPlan.Basic]: 'free',
  [ShopPlan.Plus]: 'pro',
  [ShopPlan.Pro]: 'biz',
};

/** 0=نشط · 1=مهلة · 2=منتهٍ */
export enum SubStatus {
  Active = 0,
  Grace = 1,
  Expired = 2,
}

/** نوع الفاتورة على منصة المتاجر. */
export enum InvoiceKind {
  Subscription = 0,
  StoreBuild = 1,
  Domain = 2,
  ExtraStore = 3,
  /** شراء قالب مدفوع دفعة واحدة — معرّفه في `item` */
  Template = 4,
}

/** 0=بانتظار الدفع · 1=قيد المراجعة · 2=مدفوعة · 3=مرفوضة/ملغاة */
export enum InvoiceStatus {
  Unpaid = 0,
  UnderReview = 1,
  Paid = 2,
  Rejected = 3,
}

/** مهلة بعد انتهاء الفترة قبل العودة إلى المجانية — لا يُحذف فيها شيء. */
export const GRACE_DAYS = 7;
/** أيام استحقاق الفاتورة. */
export const DUE_DAYS = 7;
/** الحد الأقصى لخانات المتاجر في الحساب الواحد. */
export const MAX_STORE_SLOTS = 5;

/** مراحل التذكير قبل الانتهاء. */
export const REMINDER_STAGES = [
  { key: 'd7', days: 7 },
  { key: 'd1', days: 1 },
] as const;

export const MS_DAY = 86_400_000;

/** مفاتيح إعدادات المنصة المسموح بتعديلها. */
export const SETTING_KEYS = new Set([
  'price.plus',
  'price.pro',
  'price.store_build',
  'price.domain',
  'price.extra_store',
  'billing.yearlyMonthsFree',
  // عملة الفوترة (رمز ISO) — الدولار افتراضيًا، كأسعار منصة المتاجر
  'billing.currency',
  'pay.kuraimi',
  'pay.jaib',
  'pay.paypal',
  // تطبيق عزم الجوال — يقرؤها عند الإقلاع (`GET /app/config`)
  'app.minVersion',
  'app.latestVersion',
  'app.maintenance',
  'app.maintenanceMessage',
  'app.storeUrl',
  'notify.emails',
  'notify.whatsapp',
]);

/** مفاتيح نصّية حرّة (لا أرقام) — تُقصّ ولا تُحوَّل. */
export const TEXT_SETTING_PREFIXES = ['pay.', 'app.maintenanceMessage', 'app.storeUrl', 'notify.'];
/** عملات الفوترة المقبولة */
export const BILLING_CURRENCIES = new Set(['USD', 'YER', 'SAR']);
/** رقم إصدار دلالي: 1.2.3 */
export const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const PAYMENT_METHODS = [
  { id: 'kuraimi', name: 'بنك الكريمي', scope: 'local', key: 'pay.kuraimi' },
  { id: 'jaib', name: 'محفظة جيب', scope: 'local', key: 'pay.jaib' },
  { id: 'paypal', name: 'PayPal', scope: 'intl', key: 'pay.paypal' },
] as const;

/**
 * مزوّدو حسابات الاستلام التي تُعرض للعملاء في صفحة «طرق الدفع».
 * `color` لون هوية المزوّد في البطاقة، و`kind` بنك أو محفظة أو دولي.
 */
export const PAY_PROVIDERS = {
  kuraimi: { name: 'بنك الكريمي', nameEn: 'Al-Kuraimi Bank', kind: 'bank', color: '#6B3FA0' },
  jaib: { name: 'محفظة جيب', nameEn: 'Jaib Wallet', kind: 'wallet', color: '#E31E24' },
  jawali: { name: 'محفظة جوالي', nameEn: 'Jawali Wallet', kind: 'wallet', color: '#0E7C86' },
  onecash: { name: 'ون كاش', nameEn: 'OneCash', kind: 'wallet', color: '#F7941D' },
  floosak: { name: 'فلوسك', nameEn: 'Floosak', kind: 'wallet', color: '#1BA39C' },
  paypal: { name: 'PayPal', nameEn: 'PayPal', kind: 'intl', color: '#003087' },
  other: { name: 'حساب آخر', nameEn: 'Other', kind: 'bank', color: '#555555' },
} as const;
export type PayProvider = keyof typeof PAY_PROVIDERS;

export interface PayAccount {
  id: string;
  provider: PayProvider;
  /** عنوان البطاقة: «حساب جاري — ريال يمني» */
  title: string;
  /** اسم صاحب الحساب كما يظهر للمحوِّل (اختياري) */
  holder: string;
  /** رقم الحساب أو المحفظة كما يُنسخ */
  number: string;
  currency: 'YER' | 'USD' | 'SAR' | '';
  /** صورة رمز QR: رابط https أو مسار ثابت في الواجهة (`/pay/…`) */
  qr: string;
  note: string;
  enabled: boolean;
}

/** الحسابات الافتراضية ما لم تضبط الإدارة غيرها من «إعدادات المنصة». */
export const DEFAULT_PAY_ACCOUNTS: PayAccount[] = [
  {
    id: 'kuraimi-yer', provider: 'kuraimi', title: 'حساب جاري — ريال يمني', holder: '',
    number: '3075249852', currency: 'YER', qr: '',
    note: 'إيداع أو حوالة إلى الحساب من أي فرع أو من تطبيق الكريمي.', enabled: true,
  },
  {
    id: 'kuraimi-usd', provider: 'kuraimi', title: 'حساب جاري — دولار أمريكي', holder: '',
    number: '3204875528', currency: 'USD', qr: '',
    note: 'للدفع بالدولار من داخل اليمن أو خارجه.', enabled: true,
  },
  {
    id: 'jaib', provider: 'jaib', title: 'محفظة جيب', holder: '',
    number: '601762', currency: '', qr: '/pay/jaib-qr.png',
    note: 'امسح الرمز من تطبيق جيب، أو حوّل إلى رقم المحفظة.', enabled: true,
  },
  {
    id: 'jawali', provider: 'jawali', title: 'محفظة جوالي', holder: 'رياش فيصل البريهي',
    number: '778211887', currency: '', qr: '/pay/jawali-qr.png',
    note: 'امسح الرمز من تطبيق جوالي، أو حوّل إلى رقم المحفظة.', enabled: true,
  },
];
