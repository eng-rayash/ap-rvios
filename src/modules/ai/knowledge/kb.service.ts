import { Injectable, Logger } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { PlatformSettingsService } from '../../shop-billing/platform-settings.service';
import { STORE_TEMPLATES } from '../../shop/store-templates';
import { KB, KbAudience, KbChunk } from './kb';

/**
 * استرجاع المعرفة: لكل سؤال تُختار الأقسام الأقرب (BM25 على نص مُطبَّع) وتوضع في تعليمات
 * المساعد — بدل إرسال القاعدة كلها مع كل طلب (تكلفة) أو لا شيء (تخمين).
 *
 * التطبيع العربي يجعل «الأسعار» و«اسعار» و«سعر» تتلاقى: حذف التشكيل والتطويل، توحيد الهمزات
 * والتاء المربوطة والألف المقصورة، ونزع «ال» وأخواتها من أول الكلمة.
 */

const TATWEEL = String.fromCharCode(0x640);
const STOP = new Set(['في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'هل', 'ما', 'ماذا', 'كيف', 'لماذا', 'هو', 'هي', 'او', 'أو', 'و', 'ثم', 'لا', 'نعم', 'انا', 'أنا', 'انت', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'كم', 'متى', 'اين', 'أين', 'لي', 'به', 'بها', 'عند', 'كل', 'اي', 'أي', 'يا', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'how', 'what', 'do', 'does', 'i', 'my', 'can', 'you', 'your', 'with', 'it']);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\p{Mn}/gu, '')
    .split(TATWEEL).join('')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

function stem(t: string): string {
  let w = t;
  for (const p of ['وال', 'بال', 'فال', 'كال', 'لل', 'ال']) {
    if (w.startsWith(p) && w.length - p.length >= 2) {
      w = w.slice(p.length);
      break;
    }
  }
  // «الإلكترونية» تصير «الكترونيه» بعد نزع «ال» الأولى، و«الكترونية» بلا تعريف تبدأ بـ«ال» أيضًا:
  // نزعها حتى لا يبقى «ال» في الأول يجعل الصيغتين كلمة واحدة
  while (w.startsWith('ال') && w.length - 2 >= 3) w = w.slice(2);
  if (w.length > 4) for (const s of ['ات', 'ون', 'ين', 'ها', 'هم']) if (w.endsWith(s)) { w = w.slice(0, -2); break; }
  return w;
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

interface Indexed { chunk: KbChunk; tf: Map<string, number>; len: number }

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private index: Indexed[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private chunks: KbChunk[] = KB;
  /** آخر تحميل لمعرفة الفريق من القاعدة — تُحدَّث كل دقيقة، وفورًا بعد أي تعديل */
  private loadedAt = 0;
  private pricing: { at: number; text: string } | null = null;

  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly prisma?: TenantPrismaService,
  ) {
    this.build(KB);
  }

  private build(chunks: KbChunk[]) {
    const df = new Map<string, number>();
    const index = chunks.map((chunk) => {
      // العنوان والكلمات المفتاحية ثلاث مرات: سؤال عن «القوالب» يجد قسم القوالب أولًا
      const head = tokens(`${chunk.title} ${chunk.tags.join(' ')}`);
      const words = [...head, ...head, ...head, ...tokens(chunk.text)];
      const tf = new Map<string, number>();
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
      return { chunk, tf, len: words.length };
    });
    this.chunks = chunks;
    this.index = index;
    this.df = df;
    this.avgLen = index.reduce((a, d) => a + d.len, 0) / Math.max(1, index.length);
  }

  /** معرفة الفريق المفعّلة + القاعدة المكتوبة — إن تعذّرت القاعدة بقيت المكتوبة تعمل */
  async ensureFresh(force = false) {
    if (!this.prisma || (!force && Date.now() - this.loadedAt < 60_000)) return;
    this.loadedAt = Date.now();
    try {
      const rows = await this.prisma.aiKnowledge.findMany({ where: { active: true }, orderBy: { updatedAt: 'desc' }, take: 500 });
      this.build([
        ...KB,
        ...rows.map((r) => ({
          id: `db:${r.id}`, title: r.title, tags: r.tags, text: r.text,
          audience: r.audience.filter((a): a is KbAudience => a === 'merchant' || a === 'public'),
        })),
      ]);
    } catch (e) {
      this.logger.warn(`تعذّر تحميل معرفة الفريق: ${(e as Error).message}`);
    }
  }

  invalidate() {
    this.loadedAt = 0;
  }

  /** أقرب الأقسام إلى السؤال، لجمهور بعينه */
  search(query: string, audience: KbAudience, k = 5): KbChunk[] {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = this.index.length;
    const k1 = 1.4;
    const b = 0.7;
    const scored = this.index
      .filter((d) => d.chunk.audience.includes(audience))
      .map((d) => {
        let score = 0;
        for (const t of q) {
          // مطابقة جزئية للكلمات الطويلة: «متجري» تجد «متجر»
          let f = d.tf.get(t) ?? 0;
          let df = this.df.get(t) ?? 0;
          if (!f && t.length >= 4) {
            for (const [w, c] of d.tf) if (w.length >= 3 && (w.startsWith(t) || t.startsWith(w))) { f += c * 0.6; df = Math.max(df, this.df.get(w) ?? 0); }
          }
          if (!f) continue;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
        }
        return { chunk: d.chunk, score };
      })
      .filter((s) => s.score > 0.8)
      .sort((x, y) => y.score - x.score);
    return scored.slice(0, k).map((s) => s.chunk);
  }

  byId(id: string): KbChunk | undefined {
    return this.chunks.find((c) => c.id === id);
  }

  /**
   * الأسعار الحيّة من إعدادات المنصة (تضبطها الإدارة) — لا رقم محفوظ في النص قد يتقادم.
   * تُخزَّن خمس دقائق.
   */
  async pricingText(): Promise<string> {
    if (this.pricing && Date.now() - this.pricing.at < 300_000) return this.pricing.text;
    let text: string;
    try {
      const [plans, currency, templates, yearly] = await Promise.all([
        this.settings.planPrices(),
        this.settings.currency(),
        this.settings.templatePrices(),
        this.settings.get<number>('billing.yearlyMonthsFree', 2),
      ]);
      const cur = currency === 'USD' ? 'دولار' : currency;
      const p = (v: number | null, fallback: number) => (v ?? fallback);
      const plus = p(plans.plus, 6);
      const pro = p(plans.pro, 15);
      const tpl = Object.entries(templates).map(([id, price]) => `${id} ${price}`).join('، ');
      text = `# أسعار منصة RVIOS Store (حيّة من إعدادات المنصة — بالـ${cur})
- المجانية: ٠ — ١٠ منتجات و٣ تصنيفات، رابط خاص، سلة وطلبات محفوظة، القالب الأساسي، بلا عمولة.
- الاحترافية: ${plus} شهريًا — ٥٠٠ منتج وتصنيفات بلا حد، إزالة عبارة المنصة، إحصائيات، شارة متجر موثّق.
- الأعمال: ${pro} شهريًا — منتجات بلا حد، القوالب القياسية مجانًا والتوقيع بخصم ٤٠٪، نطاق خاص مجاني أول سنة، ٣ حسابات فريق.
- الاشتراك السنوي: سعر ${12 - (yearly ?? 2)} شهرًا عن السنة (${yearly ?? 2} شهر مجانًا).
- القوالب المدفوعة (مرة واحدة، معرّف القالب ثم السعر): ${tpl}. القالب الأساسي (essential) مجاني.
لا عمولة على المبيعات في أي باقة.`;
    } catch (e) {
      this.logger.warn(`تعذّر قراءة الأسعار: ${(e as Error).message}`);
      const tpl = Object.entries(STORE_TEMPLATES).filter(([, t]) => t.tier !== 'free').map(([id, t]) => `${id} ${t.price}`).join('، ');
      text = `# أسعار منصة RVIOS Store (بالدولار)\n- المجانية: ٠. الاحترافية: ٦ شهريًا. الأعمال: ١٥ شهريًا. السنوي بشهرين مجانًا.\n- القوالب المدفوعة مرة واحدة: ${tpl}.`;
    }
    this.pricing = { at: Date.now(), text };
    return text;
  }

  /**
   * المعرفة التي تدخل تعليمات المساعد لهذا السؤال: الأقسام الأقرب، والأسعار حين يُسأل عن
   * سعر أو باقة. الأقسام الأساسية (من نحن، التواصل) لجمهور الموقع دائمًا.
   */
  async forQuestion(question: string, audience: KbAudience, opts: { always?: string[]; k?: number } = {}): Promise<string> {
    await this.ensureFresh();
    const picked = new Map<string, KbChunk>();
    for (const id of opts.always ?? []) {
      const c = this.byId(id);
      if (c) picked.set(c.id, c);
    }
    for (const c of this.search(question, audience, opts.k ?? 5)) picked.set(c.id, c);
    const parts = [...picked.values()].map((c) => `# ${c.title}\n${c.text}`);
    const n = normalize(question);
    if (/سعر|اسعار|تكلف|كم |بكم|باق|اشتراك|قالب|قوالب|ترقي|price|cost|plan|pricing|subscri|template|upgrade/.test(n)) {
      parts.push(await this.pricingText());
    }
    return parts.join('\n\n');
  }
}
