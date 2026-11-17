import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShopStore } from '@prisma/client';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { PushService } from '../../notify/push.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { AnswerQuestionDto, AskQuestionDto } from './questions.dto';

/** 0 بانتظار الإجابة · 1 منشور (مُجاب) · 2 مخفي */
export enum QuestionStatus {
  Pending = 0,
  Published = 1,
  Hidden = 2,
}

/**
 * أسئلة المنتج: يسأل الزائر بلا حساب، ويجيب التاجر، ولا يظهر للعامة إلا المُجاب المنشور —
 * سؤال بلا جواب في صفحة المنتج يضرّ أكثر مما ينفع، وما يكتبه الزوار لا يُنشر قبل أن يراه التاجر.
 */
@Injectable()
export class ShopQuestionsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly push: PushService,
  ) {}

  // ═══ واجهة المتجر ═════════════════════════════════════════

  async published(store: ShopStore, productId: string) {
    return this.prisma.shopQuestion.findMany({
      where: { storeId: store.id, productId, status: QuestionStatus.Published },
      orderBy: { answeredAt: 'desc' },
      take: 30,
      select: { id: true, name: true, question: true, answer: true, createdAt: true, answeredAt: true },
    });
  }

  async ask(store: ShopStore, productId: string, dto: AskQuestionDto) {
    const product = await this.prisma.shopProduct.findFirst({ where: { id: productId, storeId: store.id, live: true }, select: { id: true, name: true } });
    if (!product) throw new NotFoundException('المنتج غير موجود');
    const question = dto.question.trim();
    if (question.length < 5) throw new BadRequestException('اكتب سؤالك بوضوح');
    // سقف لما ينتظر الإجابة في المتجر — يمنع إغراقه بالرسائل
    const pending = await this.prisma.shopQuestion.count({ where: { storeId: store.id, status: QuestionStatus.Pending } });
    if (pending >= 300) throw new BadRequestException('المتجر يجيب على أسئلة سابقة — حاول لاحقًا');
    const q = await this.prisma.shopQuestion.create({
      data: {
        companyId: store.companyId,
        storeId: store.id,
        productId,
        name: (dto.name ?? '').trim().slice(0, 60),
        question: question.slice(0, 500),
      },
    });
    void this.push.toCompany(store.companyId, {
      title: `سؤال جديد عن «${product.name}»`,
      body: question.slice(0, 120),
      link: '/questions',
      kind: 'question',
      data: { storeId: store.id, questionId: q.id },
    }).catch(() => undefined);
    return { ok: true, message: 'وصل سؤالك — يظهر هنا مع إجابة المتجر' };
  }

  // ═══ لوحة التاجر ═════════════════════════════════════════

  async list(ctx: TenantContext, storeId: string, status?: number) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const [rows, counts] = await Promise.all([
      db.shopQuestion.findMany({
        where: { storeId, ...(status !== undefined ? { status } : {}) },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        include: { product: { select: { id: true, name: true, image: true } } },
      }),
      db.shopQuestion.groupBy({ by: ['status'], where: { storeId }, _count: { _all: true } }),
    ]);
    return {
      questions: rows,
      counts: { 0: 0, 1: 0, 2: 0, ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])) } as Record<number, number>,
    };
  }

  private async one(ctx: TenantContext, storeId: string, id: string) {
    const q = await this.prisma.forTenant(ctx.companyId).shopQuestion.findFirst({ where: { id, storeId } });
    if (!q) throw new NotFoundException('السؤال غير موجود');
    return q;
  }

  /** الإجابة تنشر السؤال افتراضيًا؛ والحالة وحدها تُخفي أو تعيد النشر */
  async answer(ctx: TenantContext, storeId: string, id: string, dto: AnswerQuestionDto) {
    await this.access.require(ctx, storeId, { writable: true });
    const q = await this.one(ctx, storeId, id);
    const answer = dto.answer !== undefined ? dto.answer.trim().slice(0, 1000) : q.answer;
    let status = dto.status ?? (dto.answer !== undefined ? QuestionStatus.Published : q.status);
    if (status === QuestionStatus.Published && !answer) throw new BadRequestException('اكتب الإجابة قبل النشر');
    if (status === QuestionStatus.Pending && answer) status = QuestionStatus.Published;
    return this.prisma.forTenant(ctx.companyId).shopQuestion.update({
      where: { id },
      data: {
        answer,
        status,
        ...(dto.answer !== undefined && answer && !q.answeredAt ? { answeredAt: new Date() } : {}),
      } satisfies Prisma.ShopQuestionUpdateInput,
      include: { product: { select: { id: true, name: true, image: true } } },
    });
  }

  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.one(ctx, storeId, id);
    await this.prisma.forTenant(ctx.companyId).shopQuestion.delete({ where: { id } });
    return { ok: true };
  }
}

