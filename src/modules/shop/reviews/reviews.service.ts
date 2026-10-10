import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShopStore } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { OrderStatus } from '../shop.constants';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { SubmitReviewDto, UpdateReviewDto } from './reviews.dto';

/** 0=قيد المراجعة · 1=منشور · 2=مخفي */
export enum ReviewStatus {
  Pending = 0,
  Published = 1,
  Hidden = 2,
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * تقييمات المنتجات — من مشترين فعليين وحدهم: سطر من طلب **مكتمل** في المتجر
 * نفسه، تقييم واحد لكل سطر. لا حسابات للعملاء، فالإثبات رقم الطلب المرجعي
 * (كالتتبّع ورفع الإيصال). يُنشر فورًا، وللتاجر الإخفاء والردّ.
 *
 * والمتوسّط والعدد في الواجهة من المنشور وحده — لا نجوم مصطنعة.
 */
@Injectable()
export class ShopReviewsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  // ── العامة ───────────────────────────────────────────

  /** المُقيَّم من أسطر طلبٍ برقمه — للتتبّع: أيّها ما زال يقبل تقييمًا */
  async reviewedByRef(storeId: string, ref: string): Promise<Set<string>> {
    const order = await this.prisma.shopOrder.findFirst({ where: { ref: ref.toUpperCase(), storeId }, select: { id: true } });
    if (!order) return new Set();
    const rows = await this.prisma.shopReview.findMany({ where: { orderId: order.id }, select: { orderItemId: true } });
    return new Set(rows.map((r) => r.orderItemId));
  }

  async submit(store: ShopStore, ref: string, dto: SubmitReviewDto) {
    const order = await this.prisma.shopOrder.findFirst({
      where: { ref: ref.toUpperCase(), storeId: store.id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.status !== OrderStatus.Done) {
      throw new ConflictException({ message: 'التقييم بعد استلام الطلب — حين يؤكّد المتجر اكتماله', code: 'ORDER_NOT_DONE' });
    }
    const item = order.items.find((i) => i.id === dto.itemId);
    if (!item) throw new BadRequestException('هذا المنتج ليس في طلبك');
    const product = item.productId
      ? await this.prisma.shopProduct.findFirst({ where: { id: item.productId, storeId: store.id }, select: { id: true } })
      : null;
    if (!product) throw new ConflictException('المنتج لم يعد في المتجر');

    try {
      const db = this.prisma.forTenant(store.companyId);
      const r = await db.shopReview.create({
        data: tenantCreate<Prisma.ShopReviewUncheckedCreateInput>({
          syncId: randomUUID(),
          storeId: store.id,
          productId: product.id,
          orderId: order.id,
          orderItemId: item.id,
          rating: dto.rating,
          body: dto.body.trim(),
          name: (dto.name?.trim() || order.custName || 'عميل').slice(0, 60),
          status: ReviewStatus.Published,
        }),
      });
      return { ok: true, id: r.id, message: 'شكرًا — نُشر تقييمك' };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException('قيّمت هذا المنتج من طلبك بالفعل');
      throw err;
    }
  }

  /** المنشور لمنتج — الأحدث أولًا، مع المتوسّط والعدد */
  async published(store: ShopStore, productId: string, take = 20) {
    const where = { storeId: store.id, productId, status: ReviewStatus.Published };
    const [rows, agg] = await Promise.all([
      this.prisma.shopReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(50, Math.max(1, take)),
        select: { id: true, rating: true, name: true, body: true, reply: true, createdAt: true },
      }),
      this.prisma.shopReview.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    return { average: round1(agg._avg.rating ?? 0), count: agg._count._all, reviews: rows };
  }

  /** متوسّط المنشور وعدده لكل منتج في المتجر — للكتالوج */
  async summary(storeId: string): Promise<Map<string, { average: number; count: number }>> {
    const rows = await this.prisma.shopReview.groupBy({
      by: ['productId'],
      where: { storeId, status: ReviewStatus.Published },
      _avg: { rating: true },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.productId, { average: round1(r._avg.rating ?? 0), count: r._count._all }]));
  }

  // ── التاجر ───────────────────────────────────────────

  async list(ctx: TenantContext, storeId: string, status?: number) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const [rows, counts, avg] = await Promise.all([
      db.shopReview.findMany({
        where: { storeId, ...(status !== undefined ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 300,
        include: { product: { select: { id: true, name: true, image: true } } },
      }),
      db.shopReview.groupBy({ by: ['status'], where: { storeId }, _count: { _all: true } }),
      db.shopReview.aggregate({ where: { storeId, status: ReviewStatus.Published }, _avg: { rating: true } }),
    ]);
    return {
      reviews: rows,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<number, number>,
      average: round1(avg._avg.rating ?? 0),
    };
  }

  async update(ctx: TenantContext, storeId: string, id: string, dto: UpdateReviewDto) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const r = await db.shopReview.findFirst({ where: { id, storeId } });
    if (!r) throw new NotFoundException('التقييم غير موجود');
    return db.shopReview.update({
      where: { id },
      data: {
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.reply !== undefined ? { reply: dto.reply.trim() } : {}),
      },
    });
  }
}
