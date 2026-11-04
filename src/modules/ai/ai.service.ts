import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AiConversation } from '@prisma/client';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { ShopStoreAccessService, StoreAccess } from '../shop/shop-store-access.service';
import { countryOf } from '../shop/shop.constants';
import { AI_LIMITS, AiFeature } from './ai.config';
import { AiContextService } from './ai-context.service';
import { AiChatDto, AiGenerateDto } from './ai.dto';
import { TITLE_PROMPT, TOOLS, replyLanguage, systemPrompt } from './ai.prompts';
import { redactSensitive } from './ai.sanitize';
import { AiUsageService } from './ai-usage.service';
import { KnowledgeService } from './knowledge/kb.service';
import { AI_ERROR_TEXT, AI_PROVIDER, AiProvider, AiProviderError, AiTurn, AiUsageInfo } from './providers/ai-provider';

const currencyLabel = (code: string) => {
  const c = countryOf(code);
  return `${c.symbol} (${c.currency})`;
};

/** حدث في بثّ الرد — يُكتب SSE كما هو */
export type AiEvent =
  | { type: 'start'; conversationId: string; userMessageId: string | null; mode: string }
  | { type: 'delta'; text: string }
  | { type: 'title'; title: string }
  | { type: 'done'; messageId: string; status: 'ok' | 'stopped'; used: number; limit: number }
  | { type: 'error'; code: string; message: string; messageId: string | null };

interface ChatRun {
  ctx: TenantContext;
  access: StoreAccess;
  conversation: AiConversation;
  userMessageId: string | null;
  isNew: boolean;
  firstUserText: string;
  quota: { used: number; limit: number };
}

/**
 * RVIOS AI — يجمع المحادثات والسياق والحصّة والمزوّد.
 *
 * المساعد استشاري فقط: لا أدوات ولا كتابة في جداول المتجر. كل ما يكتبه هذا الملف
 * جداول المساعد نفسه (المحادثات والرسائل والسجل).
 *
 * العزل: المحادثة تُجلب دائمًا بـ`forTenant` (الشركة) + `storeId` (بعد التحقق من
 * المتجر) + `userId` (صاحبها) — معرّف محادثة من متجر أو مستخدم آخر غير موجود.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly context: AiContextService,
    private readonly usage: AiUsageService,
    private readonly knowledge: KnowledgeService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  get ready() {
    return this.provider.ready;
  }

  // ═══ المحادثات ═══════════════════════════════════════════

  async list(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    return this.prisma.forTenant(ctx.companyId).aiConversation.findMany({
      where: { storeId, userId: ctx.userId },
      orderBy: { updatedAt: 'desc' },
      take: AI_LIMITS.conversationsPerUser,
      select: { id: true, title: true, mode: true, messageCount: true, createdAt: true, updatedAt: true },
    });
  }

  private async own(ctx: TenantContext, storeId: string, id: string) {
    const c = await this.prisma.forTenant(ctx.companyId).aiConversation.findFirst({ where: { id, storeId, userId: ctx.userId } });
    if (!c) throw new NotFoundException('المحادثة غير موجودة');
    return c;
  }

  async get(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId);
    const c = await this.own(ctx, storeId, id);
    const messages = await this.prisma.forTenant(ctx.companyId).aiMessage.findMany({
      where: { conversationId: c.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, status: true, createdAt: true },
    });
    return { id: c.id, title: c.title, mode: c.mode, createdAt: c.createdAt, updatedAt: c.updatedAt, messages };
  }

  async rename(ctx: TenantContext, storeId: string, id: string, title: string) {
    await this.access.require(ctx, storeId);
    const c = await this.own(ctx, storeId, id);
    const clean = redactSensitive(title).replace(/\s+/g, ' ').trim().slice(0, AI_LIMITS.titleChars);
    if (!clean) throw new BadRequestException('اكتب عنوانًا');
    await this.prisma.forTenant(ctx.companyId).aiConversation.update({ where: { id: c.id }, data: { title: clean } });
    return { id: c.id, title: clean };
  }

  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId);
    const c = await this.own(ctx, storeId, id);
    await this.prisma.forTenant(ctx.companyId).aiConversation.delete({ where: { id: c.id } });
    return { ok: true };
  }

  async status(ctx: TenantContext, storeId: string) {
    const access = await this.access.require(ctx, storeId);
    return { ready: this.provider.ready, ...(await this.usage.summary(ctx, storeId, access.plan)) };
  }

  // ═══ المحادثة: تحضير (قد يرمي قبل فتح البث) ثم بثّ ═══════════

  /**
   * كل ما يمكن أن يفشل برسالة واضحة يحدث هنا، قبل أن تُرسل ترويسات البث: المتجر،
   * والحصّة، والمحادثة، ورسالة التاجر. فيصل الخطأ ردًّا عاديًّا برمزه.
   */
  async prepareChat(ctx: TenantContext, storeId: string, dto: AiChatDto): Promise<ChatRun> {
    if (!this.provider.ready) throw new ServiceUnavailableException({ code: 'AI_OFF', message: AI_ERROR_TEXT.unconfigured });
    const access = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const text = redactSensitive(dto.message ?? '').trim();
    if (!dto.regenerate && !text) throw new BadRequestException('اكتب رسالتك');

    let conversation: AiConversation;
    let isNew = false;
    if (dto.conversationId) {
      conversation = await this.own(ctx, storeId, dto.conversationId);
      if (conversation.messageCount >= AI_LIMITS.messagesPerConversation) {
        throw new BadRequestException({ code: 'AI_LONG', message: 'طالت هذه المحادثة — ابدأ محادثة جديدة ليبقى الرد دقيقًا وسريعًا.' });
      }
    } else {
      if (dto.regenerate) throw new BadRequestException('لا رد لإعادة توليده');
      conversation = await db.aiConversation.create({
        data: { companyId: ctx.companyId, storeId, userId: ctx.userId, mode: dto.mode ?? 'chat' },
      });
      isNew = true;
      await this.prune(ctx, storeId);
    }

    // الحصّة بعد التحقق من المحادثة: طلب مرفوض لسبب آخر لا يُحتسب
    let quota: { used: number; limit: number };
    try {
      quota = await this.usage.assertAllowed(ctx, storeId, access.plan);
    } catch (e) {
      if (isNew) await db.aiConversation.delete({ where: { id: conversation.id } }).catch(() => undefined);
      throw e;
    }

    let userMessageId: string | null = null;
    if (dto.regenerate) {
      const last = await db.aiMessage.findFirst({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' } });
      if (!last) throw new BadRequestException('لا رد لإعادة توليده');
      if (last.role === 'model') await db.aiMessage.delete({ where: { id: last.id } });
      const lastUser = await db.aiMessage.findFirst({ where: { conversationId: conversation.id, role: 'user' }, orderBy: { createdAt: 'desc' } });
      if (!lastUser) throw new BadRequestException('لا رسالة لإعادة الرد عليها');
    } else {
      const m = await db.aiMessage.create({ data: { companyId: ctx.companyId, conversationId: conversation.id, role: 'user', content: text } });
      userMessageId = m.id;
    }
    return { ctx, access, conversation, userMessageId, isNew, firstUserText: text, quota };
  }

  async *runChat(run: ChatRun, signal: AbortSignal): AsyncGenerator<AiEvent> {
    const { ctx, access, conversation } = run;
    const db = this.prisma.forTenant(ctx.companyId);
    const storeId = access.store.id;
    const feature: AiFeature = conversation.mode === 'insights' ? 'insights' : 'chat';
    yield { type: 'start', conversationId: conversation.id, userMessageId: run.userMessageId, mode: conversation.mode };

    let text = '';
    let usage: AiUsageInfo | null = null;
    try {
      const [storeData, turns] = await Promise.all([
        this.context.build(ctx, access, feature === 'insights'),
        this.history(ctx, conversation.id),
      ]);
      const lastUser = turns.filter((t) => t.role === 'user').at(-1)?.text ?? '';
      // المعرفة حسب السؤال الأخير (ومعه ما قبله قليلًا: «وكم سعره؟» تتبع سؤالًا سابقًا)
      const query = turns.filter((t) => t.role === 'user').slice(-2).map((t) => t.text).join(' ');
      const knowledge = await this.knowledge.forQuestion(query, 'merchant', { k: 4 });
      const system = systemPrompt({ storeData, insights: feature === 'insights', currency: currencyLabel(access.store.country), lang: replyLanguage(lastUser), knowledge });
      for await (const chunk of this.provider.stream({ system, turns, signal })) {
        if (chunk.type === 'text') {
          text += chunk.text;
          yield { type: 'delta', text: chunk.text };
        } else usage = chunk.usage;
      }
    } catch (e) {
      const err = e instanceof AiProviderError ? e : new AiProviderError('network', String((e as Error)?.message ?? e));
      if (!(e instanceof AiProviderError)) this.logger.error(`RVIOS AI: ${err.message.slice(0, 300)}`);
      // «أوقفه التاجر» فقط حين أطلق هو الإيقاف — انقضاء المهلة خطأ يُبلَّغ به
      const stopped = signal.aborted;
      // ما وصل قبل الإيقاف يُحفظ كما هو: التاجر رآه، ويمكنه إعادة التوليد
      const saved = text.trim()
        ? await db.aiMessage.create({ data: { companyId: ctx.companyId, conversationId: conversation.id, role: 'model', content: text, status: stopped ? 'stopped' : 'error', model: usage?.model ?? '' } })
        : null;
      await this.touch(ctx, conversation.id);
      // يُحتسب على التاجر فقط ما وصله منه نصٌّ فعلًا
      await this.usage.record(ctx, storeId, feature, stopped ? 'stopped' : 'error', usage, { counted: !!text });
      if (stopped) {
        if (saved) yield { type: 'done', messageId: saved.id, status: 'stopped', used: run.quota.used + 1, limit: run.quota.limit };
        return;
      }
      yield { type: 'error', code: err.kind, message: AI_ERROR_TEXT[err.kind], messageId: saved?.id ?? null };
      return;
    }

    const msg = await db.aiMessage.create({
      data: {
        companyId: ctx.companyId, conversationId: conversation.id, role: 'model', content: text || '…', model: usage?.model ?? '',
        inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      },
    });
    await this.usage.record(ctx, storeId, feature, 'ok', usage);
    if (!conversation.title && run.firstUserText) {
      const title = await this.title(ctx, storeId, run.firstUserText);
      await db.aiConversation.update({ where: { id: conversation.id }, data: { title } });
      yield { type: 'title', title };
    }
    await this.touch(ctx, conversation.id);
    yield { type: 'done', messageId: msg.id, status: 'ok', used: run.quota.used + 1, limit: run.quota.limit };
  }

  /**
   * سياق المحادثة: آخر الرسائل ضمن حدّ أحرف — لا السجل كاملًا مع كل طلب. الرسائل
   * المتتالية من الدور نفسه تُدمج (المزوّد يتوقع تناوبًا)، والبداية دائمًا من التاجر.
   */
  private async history(ctx: TenantContext, conversationId: string): Promise<AiTurn[]> {
    const rows = await this.prisma.forTenant(ctx.companyId).aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: AI_LIMITS.historyMessages,
      select: { role: true, content: true, status: true },
    });
    const picked: AiTurn[] = [];
    let chars = 0;
    for (const r of rows) {
      if (r.role === 'model' && r.status === 'error') continue;
      if (chars + r.content.length > AI_LIMITS.historyChars && picked.length) break;
      chars += r.content.length;
      picked.unshift({ role: r.role === 'model' ? 'model' : 'user', text: r.content });
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

  /** عنوان قصير بالنموذج الخفيف — لا يُحتسب في الحصّة، ويعود إلى أول الرسالة إن تعذّر */
  private async title(ctx: TenantContext, storeId: string, firstText: string): Promise<string> {
    const fallback = firstText.replace(/\s+/g, ' ').slice(0, 50).trim() || 'محادثة';
    try {
      let out = '';
      let usage: AiUsageInfo | null = null;
      const system = replyLanguage(firstText) === 'en' ? `${TITLE_PROMPT}
The merchant wrote in English: write the title in English.` : TITLE_PROMPT;
      for await (const c of this.provider.stream({ system, turns: [{ role: 'user', text: firstText.slice(0, 600) }], tier: 'lite', maxOutputTokens: 40, temperature: 0.3 })) {
        if (c.type === 'text') out += c.text;
        else usage = c.usage;
      }
      await this.usage.record(ctx, storeId, 'title', 'ok', usage, { counted: false });
      const clean = out.replace(/["«»“”.\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, AI_LIMITS.titleChars);
      return clean || fallback;
    } catch {
      return fallback;
    }
  }

  private async touch(ctx: TenantContext, conversationId: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const messageCount = await db.aiMessage.count({ where: { conversationId } });
    await db.aiConversation.update({ where: { id: conversationId }, data: { messageCount } });
  }

  /** أقدم المحادثات تُحذف بعد الحدّ — فلا ينمو التخزين بلا نهاية */
  private async prune(ctx: TenantContext, storeId: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const old = await db.aiConversation.findMany({
      where: { storeId, userId: ctx.userId },
      orderBy: { updatedAt: 'desc' },
      skip: AI_LIMITS.conversationsPerUser,
      select: { id: true },
    });
    if (old.length) await db.aiConversation.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  // ═══ أدوات الكتابة: نتيجة منظّمة يحرّرها التاجر ════════════

  async generate(ctx: TenantContext, storeId: string, dto: AiGenerateDto) {
    if (!this.provider.ready) throw new ServiceUnavailableException({ code: 'AI_OFF', message: AI_ERROR_TEXT.unconfigured });
    const input = dto[dto.tool];
    if (!input) throw new BadRequestException('أكمل بيانات الطلب');
    const access = await this.access.require(ctx, storeId);
    const quota = await this.usage.assertAllowed(ctx, storeId, access.plan);
    const tool = TOOLS[dto.tool];
    const country = countryOf(access.store.country);
    const s = access.store;
    // السياسات تُكتب من إعداد المتجر الحقيقي (مدنه ورسومه وطرق دفعه) لا من افتراضات
    const policyFacts = dto.tool === 'policy'
      ? {
          city: s.city, payMethods: s.payMethods, deliveryFee: s.deliveryFee, deliveryFreeOver: s.deliveryFreeOver, deliveryNote: s.deliveryNote,
          zones: await this.prisma.forTenant(ctx.companyId).shopDeliveryZone.findMany({ where: { storeId: s.id }, take: 15, select: { name: true, fee: true } }),
        }
      : {};
    const payload = JSON.stringify({
      language: dto.language,
      store: { name: s.name, country: country.name, currency: country.currency, ...policyFacts },
      ...(dto.tool === 'marketing' ? { count: 3 } : {}),
      ...JSON.parse(JSON.stringify(input, (_k, v) => (typeof v === 'string' ? redactSensitive(v) : v))),
    });

    let out = '';
    let usage: AiUsageInfo | null = null;
    try {
      for await (const c of this.provider.stream({ system: tool.system, turns: [{ role: 'user', text: payload }], jsonSchema: tool.schema, temperature: 0.8, maxOutputTokens: 3000 })) {
        if (c.type === 'text') out += c.text;
        else usage = c.usage;
      }
    } catch (e) {
      const err = e instanceof AiProviderError ? e : new AiProviderError('network', 'unknown');
      await this.usage.record(ctx, storeId, dto.tool, 'error', usage, { counted: false });
      throw new ServiceUnavailableException({ code: `AI_${err.kind.toUpperCase()}`, message: AI_ERROR_TEXT[err.kind] });
    }
    let result: unknown;
    try {
      result = JSON.parse(out);
    } catch {
      await this.usage.record(ctx, storeId, dto.tool, 'error', usage, { counted: false });
      throw new ServiceUnavailableException({ code: 'AI_FORMAT', message: 'جاء الرد بصيغة غير متوقعة — حاول مرة أخرى.' });
    }
    await this.usage.record(ctx, storeId, dto.tool, 'ok', usage);
    return { tool: dto.tool, result, used: quota.used + 1, limit: quota.limit };
  }
}
