/**
 * منصة المتاجر — الثوابت والمعرفة المشتركة.
 *
 * أرقام لا نصوص للحالات (لا enums في Prisma) كبقية المخطط. ⚠ الأرقام عقد
 * تخزين: صفوف `shop_orders` و`shop_stores` تحملها.
 */

/** 0=نشط · 1=موقوف */
export enum StoreStatus {
  Active = 0,
  Suspended = 1,
}

/** 0=قيد التأكيد · 1=مؤكد · 2=مكتمل · 3=ملغى */
export enum OrderStatus {
  Wait = 0,
  Confirmed = 1,
  Done = 2,
  Off = 3,
}

/**
 * الانتقالات المسموحة — لا رجوع، ولا خروج من مكتمل أو ملغى.
 * المخزون حُجز وقت الطلب، فالإلغاء وحده يعيده والتأكيد لا يخصم ثانية.
 */
export const ORDER_NEXT: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.Wait]: [OrderStatus.Confirmed, OrderStatus.Off],
  [OrderStatus.Confirmed]: [OrderStatus.Done, OrderStatus.Off],
  [OrderStatus.Done]: [],
  [OrderStatus.Off]: [],
};

export const ORDER_LABEL: Record<OrderStatus, string> = {
  [OrderStatus.Wait]: 'قيد التأكيد',
  [OrderStatus.Confirmed]: 'مؤكد',
  [OrderStatus.Done]: 'مكتمل',
  [OrderStatus.Off]: 'ملغى',
};

/**
 * حالات الدفع — أربع لا ثلاث: الفرق بين «بانتظار التحويل» و«إيصال للمراجعة»
 * يهمّ التاجر، والثانية وحدها تطلب عمله.
 */
export enum PayStatus {
  None = 0, // عند الاستلام
  Await = 1, // ينتظر أن يحوّل العميل ويرفع إيصاله
  Pending = 2, // رُفع الإيصال وينتظر مراجعة التاجر
  Paid = 3, // أكّده التاجر
}

/** طرق الدفع — محلية بالكامل، بلا بوابة ولا عمولة */
export const PAY_METHODS = {
  cod: { id: 'cod', label: 'عند الاستلام', proof: false },
  wallet: { id: 'wallet', label: 'محفظة إلكترونية', proof: true },
  bank: { id: 'bank', label: 'تحويل بنكي', proof: true },
} as const;

export type PayMethodId = keyof typeof PAY_METHODS;

export const SECTORS = new Set([
  'fashion', 'perfumes', 'beauty', 'electronics', 'home', 'food', 'jewelry',
  'kids', 'health', 'auto', 'stationery', 'hardware', 'agriculture',
  'handmade', 'toys', 'other',
]);

export const SKINS = new Set(['signature', 'editorial', 'midnight']);
export const LAYOUTS = new Set(['signature', 'atelier']);

/** الحد الأقصى لمناطق التوصيل في المتجر */
export const MAX_ZONES = 40;

/**
 * حدود الباقات — تُفرض في الخادم لا في الواجهة (§٢.٢).
 * `null` = غير محدود. مفاتيح الباقة كما يعيدها `StoreSubscriptionsService.view`.
 */
export interface PlanLimits {
  products: number | null;
  imagesPerProduct: number;
  variantsPerProduct: number | null;
  subcategories: boolean;
  extraThemes: boolean;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  // كما في صفحة أسعار منصة المتاجر: المجانية ١٠ منتجات، الاحترافية ٥٠٠، الأعمال بلا حد
  basic: { products: 10, imagesPerProduct: 1, variantsPerProduct: 5, subcategories: false, extraThemes: false },
  plus: { products: 500, imagesPerProduct: 4, variantsPerProduct: 30, subcategories: true, extraThemes: false },
  pro: { products: null, imagesPerProduct: 10, variantsPerProduct: null, subcategories: true, extraThemes: true },
};

export const PLAN_NAME: Record<string, string> = {
  basic: 'المجانية',
  plus: 'الاحترافية',
  pro: 'الأعمال',
};

export function limitsOf(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.basic;
}

// ═══════════════════════════════════════════════════════════
//  الدول والعملات وأرقام الجوال
// ═══════════════════════════════════════════════════════════

interface Country {
  code: string;
  name: string;
  dial: string;
  /** نمط الجوال **المحلي** بلا رمز الدولة ولا صفر بادئ */
  mobile: RegExp;
  currency: string;
  symbol: string;
}

export const COUNTRIES: Record<string, Country> = {
  YE: { code: 'YE', name: 'اليمن', dial: '967', mobile: /^7[0137]\d{7}$/, currency: 'YER', symbol: 'ر.ي' },
  SA: { code: 'SA', name: 'السعودية', dial: '966', mobile: /^5\d{8}$/, currency: 'SAR', symbol: 'ر.س' },
  EG: { code: 'EG', name: 'مصر', dial: '20', mobile: /^1[0125]\d{8}$/, currency: 'EGP', symbol: 'ج.م' },
  JO: { code: 'JO', name: 'الأردن', dial: '962', mobile: /^7[789]\d{7}$/, currency: 'JOD', symbol: 'د.أ' },
  IQ: { code: 'IQ', name: 'العراق', dial: '964', mobile: /^7[3-9]\d{8}$/, currency: 'IQD', symbol: 'د.ع' },
  SD: { code: 'SD', name: 'السودان', dial: '249', mobile: /^9[0-9]\d{7}$/, currency: 'SDG', symbol: 'ج.س' },
  SY: { code: 'SY', name: 'سوريا', dial: '963', mobile: /^9[3-9]\d{7}$/, currency: 'SYP', symbol: 'ل.س' },
  LY: { code: 'LY', name: 'ليبيا', dial: '218', mobile: /^9[1-6]\d{7}$/, currency: 'LYD', symbol: 'د.ل' },
  OM: { code: 'OM', name: 'عُمان', dial: '968', mobile: /^[79]\d{7}$/, currency: 'OMR', symbol: 'ر.ع' },
  MA: { code: 'MA', name: 'المغرب', dial: '212', mobile: /^[67]\d{8}$/, currency: 'MAD', symbol: 'د.م' },
  DZ: { code: 'DZ', name: 'الجزائر', dial: '213', mobile: /^[567]\d{8}$/, currency: 'DZD', symbol: 'د.ج' },
  TN: { code: 'TN', name: 'تونس', dial: '216', mobile: /^[2459]\d{7}$/, currency: 'TND', symbol: 'د.ت' },
  LB: { code: 'LB', name: 'لبنان', dial: '961', mobile: /^(3\d{6}|7[01689]\d{6}|81\d{6})$/, currency: 'LBP', symbol: 'ل.ل' },
  PS: { code: 'PS', name: 'فلسطين', dial: '970', mobile: /^5[69]\d{7}$/, currency: 'ILS', symbol: '₪' },
  MR: { code: 'MR', name: 'موريتانيا', dial: '222', mobile: /^[234]\d{7}$/, currency: 'MRU', symbol: 'أ.م' },
};

export const DEFAULT_COUNTRY = 'YE';

/** أطول رموز الاتصال أولًا — وإلا التقط `20` ما يبدأ بـ`218` */
const BY_DIAL = Object.values(COUNTRIES).sort(
  (a, b) => b.dial.length - a.dial.length,
);

export function countryOf(code?: string | null): Country {
  return COUNTRIES[String(code ?? '').toUpperCase()] ?? COUNTRIES[DEFAULT_COUNTRY];
}

export const symbolOf = (code?: string | null): string => countryOf(code).symbol;

/**
 * أي صيغة يكتبها المستخدم ← E.164 بلا علامة زائد، أو '' إن تعذّر.
 * الأرقام العربية-الهندية تُحوَّل أولًا، والصفر البادئ يُسقط.
 */
export function toE164(input: unknown, fallback: string = DEFAULT_COUNTRY): string {
  const latin = String(input ?? '').replace(/[٠-٩]/g, (d) =>
    String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)),
  );
  let p = latin.replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);

  // رمز الدولة صراحةً؟ الباقي يجب أن يكون جوالًا صالحًا فيها — رقم أردني
  // محلي `770…` يبدأ بـ`77` ولا يجوز التقاطه كأنه رمز اتصال
  for (const c of BY_DIAL) {
    if (p.startsWith(c.dial)) {
      const rest = p.slice(c.dial.length);
      if (c.mobile.test(rest)) return c.dial + rest;
    }
  }

  const local = p.replace(/^0+/, '');
  const home = countryOf(fallback);
  return home.mobile.test(local) ? home.dial + local : '';
}

export function validE164(e164: unknown): boolean {
  const p = String(e164 ?? '');
  return BY_DIAL.some((c) => p.startsWith(c.dial) && c.mobile.test(p.slice(c.dial.length)));
}

// ═══════════════════════════════════════════════════════════
//  الروابط (§٥.٢)
// ═══════════════════════════════════════════════════════════

/** مسارات المنصة نفسها — لا يجوز أن يأخذها تاجر */
export const RESERVED_SLUGS = new Set([
  'api', 'assets', 'data', 'uploads', 'static', 'public', 'img', 'css', 'js',
  'dashboard', 'admin', 'login', 'logout', 'onboarding', 'start', 'signup', 'signin',
  'pricing', 'plans', 'sectors', 'about', 'contact', 'help', 'support', 'track',
  'legal', 'terms', 'privacy', 'faq', 'blog', 'docs', 'status',
  'store', 'stores', 'shop', 'shops', 'app', 'www', 'mail', 'ftp', 'cdn',
  'favicon.ico', 'robots.txt', 'sitemap.xml', 'manifest.json', 'sw.js',
  'rvios', 'rviosstore', 'index', 'home', 'search', 'cart', 'order', 'orders',
  'account', 'profile', 'settings', 'billing', 'new', 'edit', 'delete', 'test',
]);
