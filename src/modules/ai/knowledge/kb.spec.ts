import { KB } from './kb';
import { KnowledgeService, normalize, tokens } from './kb.service';

/** جودة الاسترجاع: أسئلة حقيقية بصيغ مختلفة (فصحى، عامية، إنجليزية) والقسم الذي يجب أن تجده */
describe('معرفة RVIOS AI', () => {
  const settings = {
    planPrices: async () => ({ plus: 6, pro: 15 }),
    currency: async () => 'USD',
    templatePrices: async () => ({ noir: 49, sukkar: 19 }),
    get: async () => 2,
  };
  const kb = new KnowledgeService(settings as never);
  const top = (q: string, aud: 'merchant' | 'public' = 'public', k = 3) => kb.search(q, aud, k).map((c) => c.id);

  it('التطبيع: التشكيل والهمزات والتاء المربوطة و«ال» لا تفرّق الكلمات', () => {
    expect(normalize('الأَسْعَارُ')).toBe(normalize('الاسعار'));
    expect(tokens('المتاجر الإلكترونية')).toEqual(tokens('متاجر الكترونيه'));
  });

  it.each([
    ['كيف أضيف منطقة توصيل برسوم؟', 'store-delivery', 'merchant'],
    ['ابي اسوي متجر الكتروني وش الخطوات', 'store-create', 'public'],
    ['رقم الواتس حقكم', 'rvios-contact', 'public'],
    ['How much does a website cost?', 'rvios-pricing-services', 'public'],
    ['هل عندكم قالب للعطور؟', 'store-templates', 'public'],
    ['وش هو عزم سمارت', 'azm-overview', 'public'],
    ['كيف يقيم العملاء منتجاتي', 'store-reviews', 'merchant'],
    ['ابغى اغير الخط والشعار في متجري', 'store-appearance', 'merchant'],
    ['how do customers pay cash on delivery', 'store-payments', 'public'],
    ['كيف اربط دومين خاص', 'store-domain', 'merchant'],
    ['تصدير الطلبات اكسل', 'store-orders', 'merchant'],
    ['متى ينتهي اشتراكي وكيف اجدد', 'store-billing', 'merchant'],
    ['هل تصممون صفحات هبوط للاعلانات', 'svc-landing', 'public'],
    ['موقعي بطيء وتعرض لاختراق تقدرون تصلحونه', 'svc-maintenance', 'public'],
    ['ابغى نظام لإدارة الموظفين والحضور', 'svc-systems', 'public'],
  ])('«%s» ← %s', (q, id, aud) => {
    expect(top(q, aud as 'merchant' | 'public')).toContain(id);
  });

  it('الجمهور: أقسام التاجر الداخلية لا تُعرض لزوار الموقع', () => {
    expect(kb.search('الفريق والصلاحيات', 'public', 10).map((c) => c.id)).not.toContain('store-team');
    expect(kb.search('الفريق والصلاحيات', 'merchant', 3).map((c) => c.id)).toContain('store-team');
  });

  it('سؤال عن السعر يضيف الأسعار الحيّة من الإعدادات', async () => {
    const text = await kb.forQuestion('كم سعر الباقة الاحترافية؟', 'public');
    expect(text).toContain('الاحترافية: 6 شهريًا');
    expect(text).toContain('noir 49');
    expect(await kb.forQuestion('كيف أضيف منتج', 'merchant')).not.toContain('أسعار منصة');
  });

  it('سلامة القاعدة: معرّفات فريدة، ونصوص بلا محارف اتجاه خفية', () => {
    const ids = KB.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of KB) expect(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(c.text + c.title)).toBe(false);
  });
});
