/**
 * وضع الجملة — المتجر بلا أسعار للعموم. الحذف في الخادم لا في العرض: من يقرأ الواجهة
 * البرمجية لا يرى السعر أيضًا. يبقى ما عداه (الاسم، الصور، الخيارات، التوفّر).
 */
const PRICE_KEYS = new Set(['price', 'oldPrice', 'minPrice', 'maxPrice', 'compareAt', 'subtotal', 'total', 'discount', 'deliveryFee', 'delivery', 'walletPaid']);

export function stripPrices<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, PRICE_KEYS.has(k) ? null : walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** هل الرد لمتجر جملة؟ — الكتالوج والصفحة الأولى يحملان المتجر نفسه */
export const isWholesale = (r: unknown) => !!(r && typeof r === 'object' && (r as { store?: { wholesale?: boolean } }).store?.wholesale);
