/**
 * تنقية ما يُرسل إلى المزوّد ويُحفظ: رسالة التاجر قد تحمل — سهوًا — رقم بطاقة أو
 * مفتاحًا. لا يحتاج المساعد أيًّا منهما، فيُستبدلان قبل أن يغادرا الخادم.
 */

/** خوارزمية Luhn — تفرّق رقم البطاقة الحقيقي عن رقم طلب أو جوال طويل */
function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// تبدأ البطاقات بـ٢–٦ (ماستركارد، أمريكان إكسبريس، فيزا، ديسكفر…)؛ الجوال الدولي يبدأ بصفر أو
// رمز دولة (٩٦٧…) أو «+» فلا يُخلط ببطاقة وإن صادف أن اجتاز Luhn
const CARD = /(?<![\d+])[2-6](?:[ -]?\d){12,18}(?!\d)/g;
// مفاتيح شائعة الشكل: Google (AIza… / AQ.…)، Stripe/OpenAI (sk-/pk_)، رموز JWT، GitHub
const KEY = /\b(?:AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[0-9A-Za-z]{16,}|gh[pousr]_[0-9A-Za-z]{20,}|eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,})/g;
// محارف تحكّم (عدا السطر الجديد والجدولة) واتجاهات خفية قد تُخفي نصًّا عن التاجر
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

export function redactSensitive(text: string): string {
  return text
    .replace(CONTROL, '')
    .replace(CARD, (m) => (luhn(m.replace(/\D/g, '')) ? '[رقم بطاقة محذوف]' : m))
    .replace(KEY, '[مفتاح محذوف]');
}

/** نص من بيانات المتجر يدخل التعليمات: سطر واحد، طول محدود، بلا وسوم تُغلق قسم البيانات */
export function dataText(v: unknown, max = 120): string {
  return String(v ?? '')
    .replace(CONTROL, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
