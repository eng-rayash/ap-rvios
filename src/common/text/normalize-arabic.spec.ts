import { normalizeArabic, matchesNormalized } from './normalize-arabic';

/**
 * التطبيع العربي — العقبة التقنية الأولى أمام حلّال الكيانات.
 *
 * كل حالة هنا كانت تفشل في البحث القديم (`LIKE` على الاسم الخام)
 * فشلًا صامتًا: نتيجة فارغة والمستخدم يظنّ أن السجلّ غير موجود.
 */
describe('normalizeArabic', () => {
  describe('الهمزات — أكثر مصادر الفشل شيوعًا', () => {
    it('يوحّد صور الألف', () => {
      const target = normalizeArabic('أحمد');
      expect(normalizeArabic('احمد')).toBe(target);
      expect(normalizeArabic('إحمد')).toBe(target);
      expect(normalizeArabic('آحمد')).toBe(target);
    });

    it('يطابق «احمد» اسم «أحمد» — كان يفشل', () => {
      expect(matchesNormalized('أحمد العتيبي', 'احمد')).toBe(true);
    });

    it('يوحّد الهمزة على الواو والياء', () => {
      expect(normalizeArabic('مؤسسة')).toBe(normalizeArabic('موسسة'));
      expect(normalizeArabic('قائمة')).toBe(normalizeArabic('قايمة'));
    });
  });

  describe('التاء المربوطة', () => {
    it('يطابق «شركه» اسم «شركة» — كان يفشل', () => {
      expect(matchesNormalized('شركة سحبكم', 'شركه')).toBe(true);
    });

    it('يوحّدها في آخر الكلمة', () => {
      expect(normalizeArabic('مؤسسة')).toBe(normalizeArabic('مؤسسه'));
    });
  });

  describe('الألف المقصورة', () => {
    it('يطابق «مصطفي» اسم «مصطفى» — كان يفشل', () => {
      expect(matchesNormalized('مصطفى محمد', 'مصطفي')).toBe(true);
    });
  });

  describe('التشكيل والتطويل', () => {
    it('يحذف التشكيل', () => {
      expect(normalizeArabic('مُحَمَّد')).toBe(normalizeArabic('محمد'));
    });

    it('يحذف التطويل', () => {
      expect(normalizeArabic('محـــمد')).toBe(normalizeArabic('محمد'));
    });
  });

  describe('الأرقام', () => {
    it('يحوّل العربية-الهندية إلى لاتينية', () => {
      expect(normalizeArabic('فاتورة ١٢٣')).toBe('فاتوره 123');
    });

    it('يحوّل الفارسية أيضًا', () => {
      expect(normalizeArabic('۴۵۶')).toBe('456');
    });
  });

  describe('المسافات', () => {
    it('يضغط المتكرّرة ويقصّ الأطراف', () => {
      expect(normalizeArabic('  شركة   سحبكم  ')).toBe('شركه سحبكم');
    });
  });

  describe('ما لا يفعله عمدًا', () => {
    it('لا يحذف «ال» التعريف', () => {
      // «الرياض» و«رياض» اسمان مختلفان؛ دمجهما يخلط شركات منفصلة
      expect(normalizeArabic('الرياض')).not.toBe(normalizeArabic('رياض'));
    });

    it('لا يطابق أسماء مختلفة فعلًا', () => {
      expect(matchesNormalized('أحمد', 'محمد')).toBe(false);
      expect(matchesNormalized('شركة النور', 'شركة الفجر')).toBe(false);
    });
  });

  describe('الحالات الحدّية', () => {
    it('النصّ الفارغ لا يرمي', () => {
      expect(normalizeArabic('')).toBe('');
      expect(matchesNormalized('أحمد', '')).toBe(false);
    });

    it('اللاتينية تُخفَّض', () => {
      expect(normalizeArabic('AZM Corp')).toBe('azm corp');
      expect(matchesNormalized('AZM Corp', 'azm')).toBe(true);
    });

    it('الخليط العربي اللاتيني يعمل', () => {
      expect(matchesNormalized('شركة AZM للتقنية', 'azm')).toBe(true);
    });
  });
});
