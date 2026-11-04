import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { PublicRateLimit } from '../shop/public/rate-limit';
import { AiFeature, aiConfig } from './ai.config';
import { AiUsageInfo } from './providers/ai-provider';

/** أول لحظة من الشهر الحالي بتوقيت UTC — الحصّة تتجدد مع كل شهر ميلادي */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * حصص RVIOS AI وسجل استهلاكه.
 *
 * الحصّة شهرية لكل **متجر** حسب باقته (لا لكل مستخدم): الباقة تُشترى للمتجر،
 * وفريق من خمسة لا يضاعف التكلفة خمس مرات. وفوقها حدّ اندفاع لكل مستخدم بالدقيقة.
 * السجل يحمل الرموز لا النصوص — أساس التكلفة ورصيد الذكاء الاصطناعي لاحقًا.
 */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly rate: PublicRateLimit,
  ) {}

  limitFor(plan: string): number {
    const cfg = aiConfig();
    return cfg.monthlyLimit[plan] ?? cfg.monthlyLimit.basic;
  }

  async used(ctx: TenantContext, storeId: string): Promise<number> {
    return this.prisma.forTenant(ctx.companyId).aiUsage.count({
      where: { storeId, counted: true, status: { in: ['ok', 'stopped'] }, createdAt: { gte: monthStart() } },
    });
  }

  /** قبل أي طلب إلى المزوّد: حدّ الدقيقة للمستخدم، ثم حصّة المتجر الشهرية */
  async assertAllowed(ctx: TenantContext, storeId: string, plan: string): Promise<{ used: number; limit: number }> {
    const limit = this.limitFor(plan);
    if (limit === 0) {
      throw new ForbiddenException({ code: 'AI_PLAN', message: 'المساعد الذكي غير متاح في باقتك الحالية — رقِّ باقتك من «الاشتراك».' });
    }
    this.rate.check(`ai:${ctx.userId}`, aiConfig().perMinute, 60_000);
    const used = await this.used(ctx, storeId);
    if (used >= limit) {
      throw new HttpException(
        { code: 'AI_QUOTA', message: `استُهلكت حصّة المساعد لهذا الشهر (${limit} طلب). تتجدد أول الشهر، أو رقِّ باقتك لحصّة أكبر.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { used, limit };
  }

  async record(
    ctx: TenantContext,
    storeId: string,
    feature: AiFeature,
    status: 'ok' | 'stopped' | 'error',
    usage: AiUsageInfo | null,
    opts: { counted?: boolean; provider?: string } = {},
  ): Promise<void> {
    await this.prisma.forTenant(ctx.companyId).aiUsage.create({
      data: {
        companyId: ctx.companyId,
        storeId,
        userId: ctx.userId,
        feature,
        status,
        provider: opts.provider ?? 'gemini',
        model: usage?.model ?? '',
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        thoughtsTokens: usage?.thoughtsTokens ?? 0,
        // الخطأ قبل التوليد لا يُحتسب على التاجر؛ ما بدأ ثم انقطع يُحتسب (كُلِّف فعلًا)
        counted: opts.counted ?? status !== 'error',
      },
    });
  }

  async summary(ctx: TenantContext, storeId: string, plan: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const since = monthStart();
    const [used, tokens] = await Promise.all([
      this.used(ctx, storeId),
      db.aiUsage.aggregate({ where: { storeId, createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true, thoughtsTokens: true } }),
    ]);
    const next = new Date(since);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return {
      plan,
      used,
      limit: this.limitFor(plan),
      resetsAt: next.toISOString(),
      tokens: {
        input: tokens._sum.inputTokens ?? 0,
        output: tokens._sum.outputTokens ?? 0,
        thoughts: tokens._sum.thoughtsTokens ?? 0,
      },
    };
  }
}
