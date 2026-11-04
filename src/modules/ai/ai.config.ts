/**
 * إعداد RVIOS AI — كله من البيئة، فتغيير النموذج أو الحصص لا يحتاج نشر شيفرة.
 *
 * أسماء النماذج تتغيّر عند المزوّد (نموذج يُسحب، وآخر يُضاف)، لذلك هي سلسلة لا
 * اسم واحد: يُجرَّب الأول، ويُنتقل إلى التالي **فقط** حين يرفض المزوّد الطلب قبل
 * أن يولّد شيئًا (ازدحام، أو نموذج غير متاح) — رفض لا يُحتسب تكلفةً، فلا تكلفة
 * مزدوجة. انقطاع بعد بدء التوليد لا يُعاد.
 */

const list = (v: string | undefined, fallback: string[]) =>
  v?.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : fallback;
const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export type AiFeature = 'chat' | 'insights' | 'product' | 'marketing' | 'seo' | 'title';

export function aiConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    /** مزوّد واحد اليوم (gemini) — الواجهة AiProvider تسمح بغيره */
    provider: env.AI_PROVIDER?.trim() || 'gemini',
    apiKey: env.GEMINI_API_KEY?.trim() ?? '',
    /** المحادثة والتحليلات والكتابة */
    // الخفيف أولًا: أول كلمة في ثانية وتكلفة أقل بكثير، وجودته بالعربية كافية لمساعد التاجر.
    // لجودة أعلى على حساب السرعة: GEMINI_MODELS=gemini-flash-latest,gemini-flash-lite-latest
    models: list(env.GEMINI_MODELS, ['gemini-flash-lite-latest', 'gemini-flash-latest']),
    /** مهام قصيرة رخيصة: عنوان المحادثة */
    liteModels: list(env.GEMINI_LITE_MODELS, ['gemini-flash-lite-latest']),
    /** مستوى «التفكير» الداخلي: يأكل رموزًا تُدفع ويؤخّر أول كلمة. فارغ = افتراضي النموذج */
    thinkingLevel: (env.GEMINI_THINKING_LEVEL?.trim().toUpperCase() || 'LOW') as string,
    /** مهلة الطلب الواحد بالمللي ثانية */
    timeoutMs: int(env.AI_TIMEOUT_MS, 90_000),
    /** إن لم تصل أول كلمة خلال هذا يُنتقل إلى النموذج التالي (قبل أي توليد) */
    firstTokenMs: int(env.AI_FIRST_TOKEN_MS, 20_000),
    maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 2048),
    /** طلبات شهرية لكل متجر حسب باقته — 0 يعطّل الميزة للباقة */
    monthlyLimit: {
      basic: int(env.AI_LIMIT_BASIC, 30),
      plus: int(env.AI_LIMIT_PLUS, 400),
      pro: int(env.AI_LIMIT_PRO, 2000),
    } as Record<string, number>,
    /** حدّ اندفاع لكل مستخدم: يحمي من سكربت أو ضغط متكرر */
    perMinute: int(env.AI_PER_MINUTE, 12),
  };
}

export type AiConfig = ReturnType<typeof aiConfig>;

/** حدود المحتوى — تحمي التكلفة وتمنع إغراق النموذج */
export const AI_LIMITS = {
  /** أطول رسالة يكتبها التاجر */
  messageChars: 4000,
  /** ما يُرسل من سجل المحادثة: آخر الرسائل ضمن هذا المجموع من الأحرف */
  historyChars: 14_000,
  historyMessages: 16,
  /** محادثة أطول من هذا تُغلق ويُقترح بدء أخرى — السياق يطول والتكلفة تتضاعف */
  messagesPerConversation: 120,
  /** محادثات محفوظة لكل مستخدم في متجر — الأقدم يُحذف تلقائيًا بعدها */
  conversationsPerUser: 200,
  titleChars: 80,
} as const;
