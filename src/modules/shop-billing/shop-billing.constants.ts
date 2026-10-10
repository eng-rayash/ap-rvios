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
]);

/** مفاتيح نصّية حرّة (لا أرقام) — تُقصّ ولا تُحوَّل. */
export const TEXT_SETTING_PREFIXES = ['pay.', 'app.maintenanceMessage', 'app.storeUrl'];
/** عملات الفوترة المقبولة */
export const BILLING_CURRENCIES = new Set(['USD', 'YER', 'SAR']);
/** رقم إصدار دلالي: 1.2.3 */
export const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const PAYMENT_METHODS = [
  { id: 'kuraimi', name: 'بنك الكريمي', scope: 'local', key: 'pay.kuraimi' },
  { id: 'jaib', name: 'محفظة جيب', scope: 'local', key: 'pay.jaib' },
  { id: 'paypal', name: 'PayPal', scope: 'intl', key: 'pay.paypal' },
] as const;
