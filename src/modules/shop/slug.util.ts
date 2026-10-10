import { RESERVED_SLUGS } from './shop.constants';

/**
 * الروابط لاتينية حصرًا (a–z، أرقام، شرطة). الرابط العربي يتحوّل عند النسخ
 * إلى ترميز مثل %D8%B3… فيبدو مشوّهًا في واتساب والبطاقات. لذلك نولّد
 * اقتراحًا لاتينيًا من الاسم العربي بالحرفنة، ويعدّله التاجر كما يشاء.
 */

const DIACRITICS = /[ً-ْٰـ]/g;

const AR2LAT: Record<string, string> = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'a', 'ٱ': 'a',
  'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh',
  'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'ة': 'h', 'و': 'w', 'ي': 'y', 'ى': 'a', 'ئ': 'y', 'ء': '',
  'ؤ': 'w', 'پ': 'p', 'چ': 'ch', 'ژ': 'zh', 'گ': 'g',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/** بادئات عامة لا تميّز متجرًا عن آخر («بيت» و«دار» مستثناتان عمدًا) */
const PREFIXES = /^(متجر|محل|مؤسسة|شركة)\s+/;

function translitWord(word: string): string {
  // إسقاط أدوات التعريف والجرّ الملتصقة: لل… · ال… · بال… · وال…
  const w = word.replace(/^(لل|بال|كال|فال|وال|ال)/, '');
  if (!w) return '';

  let out = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    // و وي حرفا مدّ في وسط الكلمة، وحرفا علّة في أولها
    if (ch === 'و') { out += i === 0 ? 'w' : 'u'; continue; }
    if (ch === 'ي') { out += i === 0 ? 'y' : 'i'; continue; }
    out += AR2LAT[ch] !== undefined ? AR2LAT[ch] : ch;
  }
  return out;
}

export function transliterate(input: string): string {
  return String(input ?? '')
    .replace(DIACRITICS, '')
    .replace(PREFIXES, '')
    .split(/\s+/)
    .map(translitWord)
    .filter(Boolean)
    .join(' ');
}

/** أي نص ← رابط لاتيني صالح */
export function slugify(input: string): string {
  return transliterate(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

/** سبب رفض الرابط، أو null إن صلح شكلًا (التوفّر يُفحص في الخدمة) */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'الرابط مطلوب';
  if (slug.length < 3) return 'الرابط قصير جدًا — ٣ أحرف على الأقل';
  if (slug.length > 30) return 'الرابط طويل جدًا — ٣٠ حرفًا كحد أقصى';
  if (RESERVED_SLUGS.has(slug)) return 'هذا الرابط محجوز للمنصة';
  if (/^-|-$/.test(slug)) return 'لا يبدأ الرابط أو ينتهي بشرطة';
  if (/^\d+$/.test(slug)) return 'لا يصلح رابط من أرقام فقط';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'الرابط بالإنجليزية فقط — أحرف وأرقام وشرطة';
  return null;
}
