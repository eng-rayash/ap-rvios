/**
 * واجهة مزوّد الذكاء الاصطناعي — كل ما يعرفه بقية التطبيق عن «النموذج».
 *
 * لا شيء خارج `providers/` يستورد SDK مزوّد بعينه: إضافة مزوّد آخر تعني تنفيذ
 * هذه الواجهة وتسجيله، دون لمس المحادثات أو الحصص أو الواجهات.
 */

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiTurn {
  role: 'user' | 'model';
  text: string;
}

export interface AiRequest {
  /** تعليمات النظام — هوية المساعد وقواعده وبيانات المتجر */
  system: string;
  turns: AiTurn[];
  /** lite = مهام قصيرة رخيصة (عنوان محادثة) */
  tier?: 'main' | 'lite';
  maxOutputTokens?: number;
  temperature?: number;
  /** مخطط JSON للإخراج المنظّم — يُعاد النص JSON صالحًا */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AiUsageInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export type AiChunk = { type: 'text'; text: string } | { type: 'done'; usage: AiUsageInfo; finish: string };

export interface AiProvider {
  readonly name: string;
  /** هل المفتاح مضبوط؟ بدونه تُعرض الميزة «غير مفعّلة» بدل خطأ غامض */
  readonly ready: boolean;
  stream(req: AiRequest): AsyncIterable<AiChunk>;
}

/**
 * أخطاء المزوّد مصنّفة — الرسالة للتاجر تُبنى من النوع، لا من نص المزوّد (قد
 * يحمل تفاصيل داخلية أو مفاتيح جزئية).
 */
export type AiErrorKind =
  | 'unconfigured' // لا مفتاح
  | 'auth' // مفتاح خاطئ أو بلا صلاحية
  | 'quota' // نفدت حصة المزوّد
  | 'unavailable' // ازدحام مؤقت عند المزوّد
  | 'timeout'
  | 'blocked' // رفضه المزوّد لسياسة المحتوى
  | 'aborted' // أوقفه التاجر
  | 'invalid' // طلب لا يقبله النموذج
  | 'network';

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    /** هل بدأ التوليد قبل الخطأ؟ بعده لا يُنتقل إلى نموذج آخر (تكلفة مزدوجة) */
    readonly started = false,
  ) {
    super(message);
  }
}

/** نص يُعرض للتاجر لكل نوع خطأ */
export const AI_ERROR_TEXT: Record<AiErrorKind, string> = {
  unconfigured: 'المساعد الذكي غير مفعّل بعد على هذا الخادم — تواصل مع فريق RVIOS.',
  auth: 'تعذّر الاتصال بمزوّد الذكاء الاصطناعي (مشكلة في الإعداد) — أبلغنا الفريق.',
  quota: 'الخدمة مزدحمة الآن لدى المزوّد — حاول بعد قليل.',
  unavailable: 'المساعد مزدحم الآن — حاول مرة أخرى بعد لحظات.',
  timeout: 'استغرق الرد وقتًا طويلًا — حاول مرة أخرى أو اختصر طلبك.',
  blocked: 'لا يستطيع المساعد الرد على هذا الطلب. أعد صياغته من فضلك.',
  aborted: 'أُوقف الرد.',
  invalid: 'تعذّر تنفيذ الطلب — أعد صياغته أو ابدأ محادثة جديدة.',
  network: 'انقطع الاتصال بالمزوّد — حاول مرة أخرى.',
};
