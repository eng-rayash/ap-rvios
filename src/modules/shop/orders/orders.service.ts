import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShopOrder, ShopOrderItem, ShopStore } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { MerchantNotifier } from '../../notify/merchant-notifier.service';
import { orderPayload, WebhooksService } from '../../webhooks/webhooks.service';
import { recalcStock, variantLabel, variantPrice } from '../catalog/catalog.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import {
  ORDER_LABEL,
  ORDER_NEXT,
  OrderStatus,
  PayStatus,
  toE164,
} from '../shop.constants';
import { PlaceOrderDto } from './orders.dto';
import { waLink } from './order-message';

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // بلا محارف ملتبسة
export const ORDERS_PER_PAGE = 50;

function makeRef(): string {
  let out = '';
  for (const b of randomBytes(5)) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `RS-${out}`;
}

type OrderWithItems = ShopOrder & { items: ShopOrderItem[] };

class Business extends ConflictException {}

/**
 * رسوم التوصيل — دالة في **المنطقة** لا في المتجر: رسم واحد لصنعاء وعدن
 * وحضرموت غير قابل للاستخدام. والسقوط على إعداد المتجر مقصود: المتاجر التي
 * لم تُعرّف مناطق يجب أن تعمل كما كانت.
 */
export function deliveryFor(
  store: Pick<ShopStore, 'deliveryFee' | 'deliveryFreeOver'>,
  subtotal: number,
  zone: { fee: number; freeOver: number } | null,
): number {
  const fee = Number(zone ? zone.fee : store.deliveryFee) || 0;
  const freeOver = Number(zone ? zone.freeOver : store.deliveryFreeOver) || 0;
  if (!fee) return 0;
  if (freeOver && subtotal >= freeOver) return 0;
  return fee;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly webhooks: WebhooksService,
    private readonly merchant: MerchantNotifier,
  ) {}

  /** يُطلق حدث خطاف بعد اكتمال العملية — لا ينتظر ولا يرمي. */
  private notify(
    store: ShopStore,
    event: 'order.created' | 'order.status_changed' | 'order.payment_changed',
    order: OrderWithItems,
    extra: Record<string, unknown> = {},
  ) {
    void this.webhooks.emit(store.companyId, event, { ...orderPayload(order, store), ...extra });
  }

  // ═══ إنشاء الطلب (واجهة المتجر العامة) ═══════════════════
  /**
   * ينشئ طلبًا من سلة العميل.
   *
   * الأسعار من قاعدة البيانات لا من العميل. المخزون **يُحجز هنا** لا عند
   * التأكيد: لو انتظرنا تأكيد التاجر لأمكن لعميلين أن يطلبا آخر قطعة وينجح
   * كلاهما. الحجز بخصم شرطي ذرّي (`qty >= المطلوب`) داخل معاملة واحدة —
   * لا سباق ولا حاجة لقفل صفوف.
   */
  async place(store: ShopStore, dto: PlaceOrderDto) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const placed = await this.placeOnce(store, dto);
        // بعد التزام المعاملة: لا حدث لطلب قد يُلغى بتراجعها
        this.notify(store, 'order.created', placed.order);
        void this.merchant.newOrder(store, placed.order);
        return placed;
      } catch (err) {
        // تصادم مرجع نادر (٣٢^٥) — نعيد بمرجع جديد بدل فشل الطلب
        if ((err as { code?: string }).code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }
    throw new ConflictException('تعذّر توليد رقم مرجعي فريد');
  }

  private async placeOnce(store: ShopStore, dto: PlaceOrderDto) {
    const storeId = store.id;
    const companyId = store.companyId;

    // المنطقة تُقرأ من القاعدة لا من العميل — وإلا اختار رسمًا أرخص
    const zone = dto.zoneId
      ? await this.prisma.shopDeliveryZone.findFirst({
          where: { id: dto.zoneId, storeId },
        })
      : null;
    if (dto.zoneId && !zone) {
      throw new BadRequestException('منطقة التوصيل غير متاحة في هذا المتجر');
    }

    // طريقة الدفع تُقصر على ما أعلنه التاجر فعلًا
    const allowed = store.payMethods.split(',').map((m) => m.trim()).filter(Boolean);
    const method = dto.payMethod && allowed.includes(dto.payMethod) ? dto.payMethod : 'cod';

    // دمج الأسطر المكرّرة قبل فحص المخزون؛ المفتاح يشمل الخيار
    const wanted = new Map<string, { id: string; variantId: string | null; qty: number }>();
    for (const line of dto.lines) {
      const key = `${line.id}|${line.variantId ?? ''}`;
      const prev = wanted.get(key);
      wanted.set(key, {
        id: line.id,
        variantId: line.variantId ?? null,
        qty: Math.min(99, (prev?.qty ?? 0) + line.qty),
      });
    }

    const ref = makeRef();

    return this.prisma.$transaction(async (tx) => {
      const priced: Array<{
        productId: string;
        variantId: string | null;
        name: string;
        variant: string;
        price: number;
        qty: number;
      }> = [];

      for (const { id, variantId, qty } of wanted.values()) {
        const product = await tx.shopProduct.findFirst({
          where: { id, storeId, live: true },
        });
        if (!product) throw new BadRequestException('منتج غير متاح في هذا المتجر');

        // حين يملك المنتج خيارات فالمخزون والسعر يخصّان الخيار
        let variant = null as Awaited<ReturnType<typeof tx.shopProductVariant.findFirst>>;
        if (product.hasVariants) {
          if (!variantId) {
            throw new BadRequestException(
              `اختر ${product.opt1Name || 'الخيار'} لـ«${product.name}»`,
            );
          }
          variant = await tx.shopProductVariant.findFirst({
            where: { id: variantId, productId: product.id },
          });
          if (!variant || !variant.live) {
            throw new Business(`الخيار المطلوب من «${product.name}» لم يعد متاحًا`);
          }
        }

        const stock = variant ? variant.qty : product.qty;
        const label = variant ? variantLabel(product, variant) : product.variant;
        const named = variant ? `«${product.name}» (${label})` : `«${product.name}»`;
        if (stock <= 0) throw new Business(`${named} نفد من المخزون`);
        if (stock < qty) {
          throw new Business(`لا يتوفر من ${named} سوى ${stock.toLocaleString('ar-EG')}`);
        }

        priced.push({
          productId: product.id,
          variantId: variant ? variant.id : null,
          name: product.name,
          variant: label,
          price: variant ? variantPrice(product, variant) : product.price,
          qty,
        });
      }

      const subtotal = priced.reduce((a, l) => a + l.price * l.qty, 0);
      const delivery = deliveryFor(store, subtotal, zone);
      const total = subtotal + delivery;

      // العميل يُعرَّف داخل المعاملة: لو فشل الطلب فلا يبقى عميل شبح.
      // المفتاح يُوحَّد إلى E.164: العميل نفسه يكتب 0777123456 ثم 777123456
      // وبلا توحيد يصير عميلين لكل منهما «أول طلب».
      const rawPhone = (dto.phone ?? '').trim();
      const phoneKey = toE164(rawPhone, store.country) || rawPhone;
      let customerId: string | null = null;
      if (phoneKey) {
        const found = await tx.shopCustomer.findUnique({
          where: { storeId_phone: { storeId, phone: phoneKey } },
        });
        if (found) {
          // الاسم والعنوان يُحدَّثان فقط حين يكونان فارغين — لا نمسح ما كتبه سابقًا
          await tx.shopCustomer.update({
            where: { id: found.id },
            data: {
              lastAt: new Date(),
              name: found.name || (dto.name ?? ''),
              address: found.address || (dto.address ?? ''),
            },
          });
          customerId = found.id;
        } else {
          customerId = (
            await tx.shopCustomer.create({
              data: {
                companyId,
                storeId,
                phone: phoneKey,
                name: dto.name ?? '',
                address: dto.address ?? '',
              },
            })
          ).id;
        }
      }

      const order = await tx.shopOrder.create({
        data: {
          companyId,
          storeId,
          ref,
          customerId,
          zoneId: zone?.id ?? null,
          zoneName: zone?.name ?? '',
          payMethod: method,
          // «عند الاستلام» لا ينتظر إيصالًا؛ وغيره يبدأ بانتظار الدفع
          payStatus: method === 'cod' ? PayStatus.None : PayStatus.Await,
          custName: dto.name ?? '',
          custPhone: rawPhone,
          custAddress: dto.address ?? '',
          note: dto.note ?? '',
          subtotal,
          deliveryFee: delivery,
          total,
          status: OrderStatus.Wait,
          items: {
            create: priced.map((l) => ({
              companyId,
              storeId,
              productId: l.productId,
              variantId: l.variantId,
              name: l.name,
              variant: l.variant,
              price: l.price,
              qty: l.qty,
            })),
          },
        },
        include: { items: true },
      });

      // حجز الكمية — خصم شرطي ذرّي؛ فشله يعني أن غيرنا سبقنا فيُرجَع كل شيء
      const touched = new Set<string>();
      for (const l of priced) {
        if (l.variantId) {
          const r = await tx.shopProductVariant.updateMany({
            where: { id: l.variantId, qty: { gte: l.qty } },
            data: { qty: { decrement: l.qty } },
          });
          if (!r.count) throw new Business(`«${l.name}» نفد من المخزون للتوّ`);
          touched.add(l.productId);
        } else {
          const r = await tx.shopProduct.updateMany({
            where: { id: l.productId, qty: { gte: l.qty } },
            data: { qty: { decrement: l.qty } },
          });
          if (!r.count) throw new Business(`«${l.name}» نفد من المخزون للتوّ`);
        }
      }
      // مجموع المنتج يُعاد حسابه مرة واحدة بعد كل خياراته
      for (const productId of touched) await recalcStock(tx, productId);

      return {
        order,
        priced,
        subtotal,
        delivery,
        total,
        zone: zone?.name ?? '',
        payMethod: method,
        payStatus: order.payStatus,
        wa: waLink(store, order),
      };
    });
  }

  // ═══ لوحة التاجر ═════════════════════════════════════════

  private view(o: OrderWithItems, store: ShopStore) {
    return { ...o, wa: waLink(store, o), statusLabel: ORDER_LABEL[o.status as OrderStatus] };
  }

  /**
   * مُرقَّمة على الخادم — الحدّ الثابت كان يُخفي الطلبات الأقدم نهائيًا،
   * والسجل هو ما يحتاجه التاجر وقت الخلاف مع عميل.
   */
  async list(
    ctx: TenantContext,
    storeId: string,
    { status, page }: { status?: number; page?: number },
  ) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);

    const where: Prisma.ShopOrderWhereInput = {
      storeId,
      ...(status !== undefined && status in ORDER_NEXT ? { status } : {}),
    };
    const total = await db.shopOrder.count({ where });
    const pages = Math.max(1, Math.ceil(total / ORDERS_PER_PAGE));
    const current = Math.min(Math.max(1, page ?? 1), pages);

    const [rows, grouped] = await Promise.all([
      db.shopOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ORDERS_PER_PAGE,
        skip: (current - 1) * ORDERS_PER_PAGE,
        include: { items: true },
      }),
      db.shopOrder.groupBy({ by: ['status'], where: { storeId }, _count: { _all: true } }),
    ]);

    const counts: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;

    return {
      orders: rows.map((o) => this.view(o, store)),
      page: current,
      pages,
      total,
      perPage: ORDERS_PER_PAGE,
      counts,
    };
  }

  async get(ctx: TenantContext, storeId: string, id: string) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const o = await db.shopOrder.findFirst({ where: { id, storeId }, include: { items: true } });
    if (!o) throw new NotFoundException('الطلب غير موجود');
    return this.view(o, store);
  }

  /** تغيير الحالة مع احترام الانتقالات؛ الإلغاء يعيد المخزون. */
  async advance(ctx: TenantContext, storeId: string, id: string, to: OrderStatus) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const order = await db.shopOrder.findFirst({
      where: { id, storeId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');

    const allowed = ORDER_NEXT[order.status as OrderStatus] ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `لا يمكن الانتقال من «${ORDER_LABEL[order.status as OrderStatus] ?? order.status}» إلى هذه الحالة`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // المخزون حُجز وقت الطلب، فالإلغاء يعيده — والتأكيد لا يخصم ثانية
      if (to === OrderStatus.Off) {
        const touched = new Set<string>();
        for (const item of order.items) {
          if (!item.productId) continue;
          if (item.variantId) {
            // الخيار قد يكون حُذف بعد الطلب؛ حينها لا مكان تُعاد إليه
            const r = await tx.shopProductVariant.updateMany({
              where: { id: item.variantId },
              data: { qty: { increment: item.qty } },
            });
            if (r.count) touched.add(item.productId);
            continue;
          }
          await tx.shopProduct.updateMany({
            where: { id: item.productId },
            data: { qty: { increment: item.qty } },
          });
        }
        for (const productId of touched) await recalcStock(tx, productId);
      }
      return tx.shopOrder.update({
        where: { id },
        data: { status: to },
        include: { items: true },
      });
    });
    this.notify(store, 'order.status_changed', updated, { previousStatus: order.status });
    return this.view(updated, store);
  }

  /** تأكيد دفع طلب — قرار التاجر وحده: المنصة لا تتحقق من الإيصال ولا تضمنه. */
  async setPayment(ctx: TenantContext, storeId: string, id: string, paid: boolean) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const order = await db.shopOrder.findFirst({ where: { id, storeId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.payMethod === 'cod') {
      throw new BadRequestException('هذا الطلب دفعه عند الاستلام');
    }
    // الرفض يعيد الطلب إلى «بانتظار التحويل» لا إلى الصفر: العميل قد يرفع
    // إيصالًا صحيحًا بعد خاطئ ولا يبدأ من جديد
    const payStatus = paid ? PayStatus.Paid : PayStatus.Await;
    const updated = await db.shopOrder.update({ where: { id }, data: { payStatus }, include: { items: true } });
    this.notify(store, 'order.payment_changed', updated, { previousPayStatus: order.payStatus });
    return { ok: true, payStatus };
  }

  // ═══ العملاء ═════════════════════════════════════════════
  /**
   * الإحصاءات تُحسب بالاستعلام ولا تُخزَّن: العدّاد المخزَّن ينحرف عند كل
   * إلغاء، وانحرافه صامت — التاجر يرى رقمًا خاطئًا ولا شيء يكسر لينبّهه.
   */
  async customers(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const customers = await db.shopCustomer.findMany({
      where: { storeId },
      orderBy: { lastAt: 'desc' },
      take: 300,
    });
    const stats = await db.shopOrder.groupBy({
      by: ['customerId'],
      where: { storeId, customerId: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const spent = await db.shopOrder.groupBy({
      by: ['customerId'],
      where: {
        storeId,
        customerId: { not: null },
        status: { in: [OrderStatus.Confirmed, OrderStatus.Done] },
      },
      _sum: { total: true },
    });
    const byC = new Map(stats.map((s) => [s.customerId, s]));
    const spentBy = new Map(spent.map((s) => [s.customerId, s._sum.total ?? 0]));

    const rows = customers.map((c) => ({
      ...c,
      ordersCount: byC.get(c.id)?._count._all ?? 0,
      spent: spentBy.get(c.id) ?? 0,
      lastOrder: byC.get(c.id)?._max.createdAt ?? null,
    }));
    return {
      customers: rows,
      total: await db.shopCustomer.count({ where: { storeId } }),
      // العائدون هم الحجّة البيعية الحقيقية للتاجر
      returning: rows.filter((c) => c.ordersCount > 1).length,
    };
  }

  // ═══ الدفع من العميل والمتابعة (عامّان) ════════════════════

  /** رفع إيصال التحويل — تنتقل الحالة إلى «بانتظار مراجعتك». */
  /**
   * الطلب الذي يقبل إيصالًا: موجود في هذا المتجر، ودفعه بالتحويل، ولم يؤكَّد
   * بعد. يُستدعى **قبل** رفع الصورة كي لا يُخزَّن ملف لطلب لا يقبله.
   */
  async proofTarget(store: ShopStore, ref: string) {
    const order = await this.prisma.shopOrder.findFirst({
      where: { ref: ref.toUpperCase(), storeId: store.id },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.payMethod === 'cod') throw new BadRequestException('هذا الطلب دفعه عند الاستلام');
    if (order.payStatus === PayStatus.Paid) throw new BadRequestException('الطلب مؤكد الدفع مسبقًا');
    return order;
  }

  /** يسجّل الإيصال (رابط صورة رُفعت لتوّها إلى مجلد المتجر) وينتظر مراجعة التاجر. */
  async submitProof(store: ShopStore, ref: string, image: string) {
    const order = await this.proofTarget(store, ref);
    const updated = await this.prisma.shopOrder.update({
      where: { id: order.id },
      data: { payProof: image, payStatus: PayStatus.Pending },
      include: { items: true },
    });
    this.notify(store, 'order.payment_changed', updated, { previousPayStatus: order.payStatus });
    return { ok: true, message: 'وصل إيصالك — بانتظار تأكيد المتجر' };
  }

  /** متابعة طلب برقمه المرجعي. */
  async track(store: ShopStore, ref: string) {
    const o = await this.prisma.shopOrder.findFirst({
      where: { ref: ref.toUpperCase(), storeId: store.id },
      include: { items: true },
    });
    if (!o) throw new NotFoundException('لا يوجد طلب بهذا الرقم');
    const awaiting = o.payMethod !== 'cod' && o.payStatus !== PayStatus.Paid;
    return {
      ref: o.ref,
      status: o.status,
      payMethod: o.payMethod,
      payStatus: o.payStatus,
      // تعليمات التحويل ما دام الدفع لم يكتمل — العميل قد يعود ليدفع لاحقًا
      payNote: awaiting ? store.payNote : '',
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      total: o.total,
      // المعرّف لتقييم السطر بعد الاستلام — لا يكشف شيئًا لا يملكه صاحب الرقم
      items: o.items.map((i) => ({ id: i.id, productId: i.productId, name: i.name, variant: i.variant, price: i.price, qty: i.qty })),
      createdAt: o.createdAt,
    };
  }
}

