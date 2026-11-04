import { Logger } from '@nestjs/common';
import { ApiError, GoogleGenAI, type GenerateContentConfig, type ThinkingLevel } from '@google/genai';

import { AiConfig } from '../ai.config';
import { AiChunk, AiProvider, AiProviderError, AiRequest, AiUsageInfo } from './ai-provider';

/**
 * Google Gemini عبر SDK الرسمي (`@google/genai`) — على الخادم وحده.
 *
 * المفتاح لا يغادر هذا الملف: لا يُسجَّل، ولا يُعاد في خطأ (رسائل SDK تُصنَّف ثم
 * تُستبدل بنص عربي ثابت قبل أن تصل إلى أي طرف).
 *
 * سلسلة النماذج: يُنتقل إلى التالي حين يرفض المزوّد **قبل** التوليد (٥٠٣ ازدحام،
 * ٤٠٤ نموذج مسحوب)، فالرفض لا يُحتسب ولا تكلفة مزدوجة. ورفض «مستوى التفكير»
 * لنموذج لا يدعمه يُعاد على النموذج نفسه بلا ضبط التفكير.
 */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  private readonly logger = new Logger('GeminiProvider');
  private readonly client: GoogleGenAI | null;

  constructor(private readonly cfg: AiConfig) {
    this.client = cfg.apiKey ? new GoogleGenAI({ apiKey: cfg.apiKey }) : null;
  }

  get ready() {
    return !!this.client;
  }

  async *stream(req: AiRequest): AsyncIterable<AiChunk> {
    if (!this.client) throw new AiProviderError('unconfigured', 'GEMINI_API_KEY غير مضبوط');
    const chain = req.tier === 'lite' ? this.cfg.liteModels : this.cfg.models;
    let last: AiProviderError | null = null;

    for (const model of chain) {
      let thinking = !!this.cfg.thinkingLevel && this.cfg.thinkingLevel !== 'OFF';
      for (let attempt = 0; attempt < 2; attempt++) {
        let started = false;
        // مهلة أول كلمة: نموذج مزدحم قد لا يرفض بل يعلّق دقيقة كاملة — بعدها يُنتقل إلى التالي
        // قبل أن يبدأ التوليد، والتاجر لا ينتظر شاشة فارغة
        const local = new AbortController();
        const signal = req.signal ? AbortSignal.any([req.signal, local.signal]) : local.signal;
        let slow = false;
        const timer = setTimeout(() => {
          slow = true;
          local.abort();
        }, this.cfg.firstTokenMs);
        try {
          const stream = await this.client.models.generateContentStream({
            model,
            contents: req.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
            config: this.config(req, thinking, signal),
          });
          let usage: AiUsageInfo = { model, inputTokens: 0, outputTokens: 0, thoughtsTokens: 0 };
          let finish = '';
          for await (const chunk of stream) {
            const text = chunk.text ?? '';
            if (text) {
              if (!started) clearTimeout(timer);
              started = true;
              yield { type: 'text', text };
            }
            const u = chunk.usageMetadata;
            if (u) {
              usage = {
                model: chunk.modelVersion || model,
                inputTokens: u.promptTokenCount ?? usage.inputTokens,
                outputTokens: u.candidatesTokenCount ?? usage.outputTokens,
                thoughtsTokens: u.thoughtsTokenCount ?? usage.thoughtsTokens,
              };
            }
            const f = chunk.candidates?.[0]?.finishReason;
            if (f) finish = String(f);
            const blocked = chunk.promptFeedback?.blockReason;
            if (blocked && !started) throw new AiProviderError('blocked', String(blocked));
          }
          if (!started && /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(finish)) {
            throw new AiProviderError('blocked', finish);
          }
          yield { type: 'done', usage, finish };
          return;
        } catch (e) {
          const err = slow && !started ? new AiProviderError('timeout', 'first token', false) : this.classify(e, started, req.signal);
          // مستوى تفكير لا يدعمه هذا النموذج: مرة ثانية بلا ضبط التفكير
          if (err.kind === 'invalid' && thinking && /thinking/i.test(String((e as Error)?.message))) {
            thinking = false;
            continue;
          }
          last = err;
          const switchable =
            !err.started &&
            (err.kind === 'unavailable' || (err.kind === 'timeout' && slow) || (err.kind === 'invalid' && /not found|no longer available/i.test(String((e as Error)?.message))));
          if (switchable) {
            this.logger.warn(`النموذج ${model} غير متاح الآن (${err.kind}) — الانتقال إلى التالي`);
            break; // النموذج التالي في السلسلة
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    throw last ?? new AiProviderError('unavailable', 'لا نموذج متاح');
  }

  private config(req: AiRequest, thinking: boolean, signal: AbortSignal): GenerateContentConfig {
    return {
      systemInstruction: req.system,
      maxOutputTokens: req.maxOutputTokens ?? this.cfg.maxOutputTokens,
      temperature: req.temperature ?? 0.7,
      ...(thinking ? { thinkingConfig: { thinkingLevel: this.cfg.thinkingLevel as ThinkingLevel } } : {}),
      ...(req.jsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema } : {}),
      httpOptions: { timeout: this.cfg.timeoutMs },
      abortSignal: signal,
    };
  }

  /** يصنّف خطأ SDK دون أن يحمل نصّه إلى التاجر */
  private classify(e: unknown, started: boolean, userSignal?: AbortSignal): AiProviderError {
    if (e instanceof AiProviderError) return e;
    const msg = String((e as Error)?.message ?? e);
    if ((e as Error)?.name === 'AbortError' || /aborted/i.test(msg)) {
      // كلاهما يصل «aborted» من fetch: إيقاف التاجر (إشارته أُطلقت) أو انقضاء مهلة الطلب
      return new AiProviderError(userSignal?.aborted ? 'aborted' : 'timeout', 'aborted', started);
    }
    if (e instanceof ApiError) {
      const s = e.status;
      if (s === 401 || s === 403) return new AiProviderError('auth', `HTTP ${s}`, started);
      if (s === 429) return new AiProviderError('quota', 'HTTP 429', started);
      if (s === 503 || s === 500 || s === 502 || s === 504) return new AiProviderError('unavailable', `HTTP ${s}`, started);
      if (s === 400 && /API key|API_KEY/i.test(msg)) return new AiProviderError('auth', 'HTTP 400 key', started);
      if (s === 400 || s === 404) return new AiProviderError('invalid', msg.slice(0, 300), started);
    }
    if (/timeout|ETIMEDOUT/i.test(msg)) return new AiProviderError('timeout', 'timeout', started);
    if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) return new AiProviderError('network', 'network', started);
    this.logger.error(`خطأ غير مصنّف من Gemini: ${msg.slice(0, 200)}`);
    return new AiProviderError('network', 'unknown', started);
  }
}
