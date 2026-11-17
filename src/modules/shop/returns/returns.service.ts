import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShopOrderItem, ShopStore } from '@prisma/client';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { PushService } from '../../notify/push.service';
import { recalcStock } from '../catalog/catalog.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { OrderStatus } from '../shop.constants';
import { LoyaltyService } from '../loyalty/loyalty';
import { CreateReturnDto, RequestReturnDto, UpdateReturnDto } from './returns.dto';

/** 0 طلب العميل · 1 مقبول (بانتظار الاستلام) · 2 مرفوض · 3 مكتمل */
export enum ReturnStatus {
  Requested = 0,
  Approved = 1,
  Rejected = 2,
  Completed = 3,
}

/** مهلة طلب الاسترجاع من العميل بعد الطلب — التاجر يسجّل مرتجعًا يدويًا في أي وقت */
export const RETURN_DAYS = 14;

type Tx = Prisma.TransactionClient;
const OPEN = [ReturnStatus.Requested, ReturnStatus.Approved];

/**
 * المرتجعات: العميل يطلب من صفحة تتبّع طلب مكتمل، والتاجر يقبل أو يرفض، ثم يُتمّه بمبلغ مُعاد
 * واختيار إعادة الكمية للمخزون. الإتمام يحوّل الطلب إلى «مُرجَع» فيخرج من المبيعات والأرباح.
 */
@Injectable()
export class ShopReturnsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly push: PushService,
    private readonly loyalty: LoyaltyService,
  ) {}

  // ═══ العميل ═══════════════════════════════════════════════

  /** ما يراه صاحب رقم الطلب عن آخر طلب استرجاع */
  async forTracking(storeId: string, orderId: string) {
    const r = await this.prisma.shopReturn.findFirst({
      where: { storeId, orderId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, note: true, refund: true, createdAt: true },
    });
    return r ?? null;
  }

  async request(store: ShopStore, ref: string, dto: RequestReturnDto) {
    const order = await this.prisma.shopOrder.findFirst({ where: { ref: ref.toUpperCase(), storeId: store.id } });
    if (!order) throw new NotFoundException('لا يوجد طلب بهذا الرقم');
    if (order.status !== OrderStatus.Done) throw new ConflictException('يُطلب الاسترجاع بعد استلام الطلب');
    if (Date.now() - order.createdAt.getTime() > RETURN_DAYS * 86_400_000) {
      throw new ConflictException(`انتهت مهلة الاسترجاع (${RETURN_DAYS} يومًا) — تواصل مع المتجر`);
    }
    const open = await this.prisma.shopReturn.findFirst({ where: { orderId: order.id, status: { in: OPEN } } });
    if (open) throw new ConflictException('طلب الاسترجاع قيد المراجعة');
    const r = await this.prisma.shopReturn.create({
      data: {
        companyId: store.companyId,
        storeId: store.id,
        orderId: order.id,
        reason: dto.reason.trim().slice(0, 500),
        refund: order.total,
        source: 'customer',
      },
    });
    void this.push.toCompany(store.companyId, {
      title: `طلب استرجاع ${order.ref}`,
      body: r.reason.slice(0, 120),
      link: '/returns',
      kind: 'return',
      data: { storeId: store.id, orderId: order.id },
    }).catch(() => undefined);
    return { ok: true, message: 'وصل طلب الاسترجاع — يراجعه المتجر ويتواصل معك' };
  }

  // ═══ لوحة التاجر ═════════════════════════════════════════

  async list(ctx: TenantContext, storeId: string, status?: number) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const [rows, counts] = await Promise.all([
      db.shopReturn.findMany({
        where: { storeId, ...(status !== undefined ? { status } : {}) },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        include: { order: { select: { id: true, ref: true, total: true, custName: true, custPhone: true, createdAt: true, items: { select: { name: true, variant: true, qty: true, price: true } } } } },
      }),
      db.shopReturn.groupBy({ by: ['status'], where: { storeId }, _count: { _all: true } }),
    ]);
    return {
      returns: rows,
      counts: { 0: 0, 1: 0, 2: 0, 3: 0, ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])) } as Record<number, number>,
    };
  }

  /** مرتجع يسجّله التاجر (اتصال، محل) — لطلب مكتمل أو مشحون، ويمكن إتمامه فورًا */
  async create(ctx: TenantContext, storeId: string, dto: CreateReturnDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const order = await db.shopOrder.findFirst({ where: { id: dto.orderId, storeId }, include: { items: true } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.status !== OrderStatus.Done && order.status !== OrderStatus.Shipped) {
      throw new ConflictException('يُسجَّل المرتجع لطلب مشحون أو مكتمل — الطلب قبلهما يُلغى');
    }
    const open = await db.shopReturn.findFirst({ where: { orderId: order.id, status: { in: OPEN } } });
    if (open) throw new ConflictException('لهذا الطلب مرتجع مفتوح');
    const r = await db.shopReturn.create({
      data: {
        companyId: store.companyId,
        storeId,
        orderId: order.id,
        reason: (dto.reason ?? '').trim().slice(0, 500),
        refund: Math.min(order.total, dto.refund ?? order.total),
        restock: dto.restock ?? true,
        source: 'merchant',
        status: ReturnStatus.Approved,
      },
    });
    if (dto.complete) return this.update(ctx, storeId, r.id, { status: ReturnStatus.Completed });
    return r;
  }

  async update(ctx: TenantContext, storeId: string, id: string, dto: UpdateReturnDto) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const r = await db.shopReturn.findFirst({ where: { id, storeId }, include: { order: { include: { items: true } } } });
    if (!r) throw new NotFoundException('المرتجع غير موجود');
    if (r.status === ReturnStatus.Completed || r.status === ReturnStatus.Rejected) {
      throw new ConflictException('أُغلق هذا المرتجع');
    }
    const refund = dto.refund !== undefined ? Math.min(r.order.total, Math.max(0, dto.refund)) : r.refund;
    const restock = dto.restock ?? r.restock;
    const note = dto.note !== undefined ? dto.note.trim().slice(0, 300) : r.note;
    const to = dto.status ?? r.status;
    if (to === ReturnStatus.Requested && r.status !== ReturnStatus.Requested) throw new BadRequestException('لا رجوع لحالة الطلب');

    if (to !== ReturnStatus.Completed) {
      return db.shopReturn.update({ where: { id }, data: { status: to, refund, restock, note } });
    }
    // الإتمام: المخزون والطلب والمرتجع معًا أو لا شيء
    return this.prisma.$transaction(async (tx) => {
      if (restock) await restoreStock(tx, r.order.items);
      await tx.shopOrder.update({ where: { id: r.orderId }, data: { status: OrderStatus.Returned } });
      // ما كُسب من الطلب يُسحب
      await this.loyalty.revoke(tx, r.orderId);
      return tx.shopReturn.update({ where: { id }, data: { status: ReturnStatus.Completed, refund, restock, note } });
    });
  }
}

/** يعيد كميات أسطر الطلب إلى المخزون (كما في إلغاء الطلب) */
async function restoreStock(tx: Tx, items: ShopOrderItem[]) {
  const touched = new Set<string>();
  for (const item of items) {
    if (!item.productId) continue;
    if (item.variantId) {
      const r = await tx.shopProductVariant.updateMany({ where: { id: item.variantId }, data: { qty: { increment: item.qty } } });
      if (r.count) touched.add(item.productId);
      continue;
    }
    await tx.shopProduct.updateMany({ where: { id: item.productId }, data: { qty: { increment: item.qty } } });
  }
  for (const productId of touched) await recalcStock(tx, productId);
}

