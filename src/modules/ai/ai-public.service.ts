import { HttpException, HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { PublicRateLimit } from '../shop/public/rate-limit';
import { AiPublicChatDto } from './ai-public.dto';
import { publicPrompt, replyLanguage } from './ai.prompts';
import { redactSensitive } from './ai.sanitize';
import { KnowledgeService } from './knowledge/kb.service';
import { AI_ERROR_TEXT, AI_PROVIDER, AiProvider, AiProviderError, AiTurn, AiUsageInfo } from './providers/ai-provider';

export type AiPublicEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; status: 'ok' | 'stopped'; remaining: number }
  | { type: 'error'; code: string; message: string };

const int = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
const dayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * مساعد الزوّار على www.rvios.com وstore.rvios.com — بلا حساب ولا بيانات أحد.
 *
 * لا يُحفظ شيء من المحادثة على الخادم: المتصفح يرسل آخر الرسائل مع كل سؤال (حتى ١٢)، والخادم
 * يقصّها ويتحقق منها. ما يُحفظ سجل استهلاك بلا نص، ببصمة عنوان مملّحة.
 *
 * التكلفة مفتوحة للعالم، فثلاث بوّابات قبل أي طلب إلى المزوّد: حدّ بالدقيقة لكل عنوان (ذاكرة)،
 * وحدّ يومي لكل عنوان، وسقف يومي للمنصة كلها (قاعدة) — و`AI_PUBLIC_DAILY=0` يطفئ المساعد.
 */
@Injectable()
export class AiPublicService {
  private readonly logger = new Logger(AiPublicService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly rate: PublicRateLimit,
    private readonly knowledge: KnowledgeService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  private limits() {
    return {
      daily: int(process.env.AI_PUBLIC_DAILY, 1500),
      perIpDay: int(process.env.AI_PUBLIC_PER_IP_DAY, 40),
      perMinute: int(process.env.AI_PUBLIC_PER_MINUTE, 6),
    };
  }

  static ipHash(ip: string): string {
    const salt = process.env.VISIT_SALT ?? 'dev-visit-salt';
    return createHash('sha256').update(`ai:${salt}:${ip}`).digest('hex').slice(0, 32);
  }

  /** يُرمى قبل فتح البث: تعطيل، أو حدّ، أو مدخلات غير صالحة */
  async prepare(dto: AiPublicChatDto, ip: string) {
    const lim = this.limits();
    if (!this.provider.ready || lim.daily === 0) throw new ServiceUnavailableException({ code: 'AI_OFF', message: 'المساعد غير متاح الآن — تواصل معنا على واتساب.' });
    const ipHash = AiPublicService.ipHash(ip || 'unknown');
    this.rate.check(`ai-public:${ipHash}`, lim.perMinute, 60_000);
    const since = dayStart();
    const [all, mine] = await Promise.all([
      this.prisma.aiPublicUsage.count({ where: { createdAt: { gte: since }, counted: true } }),
      this.prisma.aiPublicUsage.count({ where: { ipHash, createdAt: { gte: since }, counted: true } }),
    ]);
    if (all >= lim.daily) throw new HttpException({ code: 'AI_BUSY', message: 'المساعد مشغول جدًا اليوم — راسلنا على واتساب ونرد عليك مباشرة.' }, HttpStatus.TOO_MANY_REQUESTS);
    if (mine >= lim.perIpDay) throw new HttpException({ code: 'AI_QUOTA', message: 'وصلت حدّ الأسئلة اليوم — نكمل معك على واتساب، أو عد غدًا.' }, HttpStatus.TOO_MANY_REQUESTS);

    const turns = this.clean(dto.turns);
    if (!turns.length || turns[turns.length - 1].role !== 'user') throw new HttpException({ code: 'AI_EMPTY', message: 'اكتب سؤالك' }, HttpStatus.BAD_REQUEST);
    return { ipHash, turns, remaining: Math.max(0, lim.perIpDay - mine - 1) };
  }

  /**
   * سجل يرسله المتصفح لا يُصدَّق: يُقصّ إلى آخر ١٠ رسائل ضمن ٨ آلاف حرف، وتُنقّى رسائل الزائر،
   * ويُدمج المتتالي من الدور نفسه، ويبدأ دائمًا بالزائر.
   */
  private clean(raw: { role: string; text: string }[]): AiTurn[] {
    const picked: AiTurn[] = [];
    let chars = 0;
    for (const t of raw.slice(-10).reverse()) {
      const role = t.role === 'model' ? 'model' : 'user';
      const text = (role === 'user' ? redactSensitive(t.text) : t.text).trim().slice(0, role === 'user' ? 1000 : 3000);
      if (!text) continue;
      if (chars + text.length > 8000 && picked.length) break;
      chars += text.length;
      picked.unshift({ role, text });
    }
    while (picked.length && picked[0].role !== 'user') picked.shift();
    const merged: AiTurn[] = [];
    for (const t of picked) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === t.role) prev.text += `\n\n${t.text}`;
      else merged.push({ ...t });
    }
    return merged;
  }

  async *run(dto: AiPublicChatDto, prep: { ipHash: string; turns: AiTurn[]; remaining: number }, signal: AbortSignal): AsyncGenerator<AiPublicEvent> {
    const users = prep.turns.filter((t) => t.role === 'user');
    const last = users.at(-1)?.text ?? '';
    const lang = dto.lang === 'en' && replyLanguage(last) !== 'ar' ? 'en' : replyLanguage(last);
    let text = '';
    let usage: AiUsageInfo | null = null;
    try {
      const knowledge = await this.knowledge.forQuestion(users.slice(-2).map((t) => t.text).join(' '), 'public', {
        always: dto.site === 'platform' ? ['store-overview', 'rvios-contact'] : ['rvios-about', 'rvios-contact'],
        k: 5,
      });
      const system = publicPrompt({ site: dto.site, lang, knowledge, page: (dto.page ?? '').slice(0, 120) });
      for await (const c of this.provider.stream({ system, turns: prep.turns, maxOutputTokens: 900, temperature: 0.4, signal })) {
        if (c.type === 'text') {
          text += c.text;
          yield { type: 'delta', text: c.text };
        } else usage = c.usage;
      }
    } catch (e) {
      const err = e instanceof AiProviderError ? e : new AiProviderError('network', String((e as Error)?.message ?? e));
      if (!(e instanceof AiProviderError)) this.logger.error(`مساعد الزوار: ${err.message.slice(0, 200)}`);
      await this.record(dto.site, prep.ipHash, signal.aborted ? 'stopped' : 'error', usage, !!text);
      if (signal.aborted) return;
      yield { type: 'error', code: err.kind, message: AI_ERROR_TEXT[err.kind] };
      return;
    }
    await this.record(dto.site, prep.ipHash, 'ok', usage, true);
    yield { type: 'done', status: 'ok', remaining: prep.remaining };
  }

  private async record(site: string, ipHash: string, status: string, usage: AiUsageInfo | null, counted: boolean) {
    await this.prisma.aiPublicUsage
      .create({
        data: {
          site, ipHash, status, counted,
          model: usage?.model ?? '', inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, thoughtsTokens: usage?.thoughtsTokens ?? 0,
        },
      })
      .catch((e) => this.logger.warn(`سجل استهلاك الزوار: ${(e as Error).message}`));
  }
}
