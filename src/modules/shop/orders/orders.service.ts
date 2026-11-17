import { StoreEmails } from '../../notify/store-emails.service';
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
  SOLD_STATUSES,
  OrderStatus,
  PayStatus,
  toE164,
} from '../shop.constants';
import { ManualOrderDto, PlaceOrderDto } from './orders.dto';
import { waLink } from './order-message';

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // بلا محارف ملتبسة
export const ORDERS_PER_PAGE = 50;
export const ORDERS_EXPORT_MAX = 5000;

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

import { PAY_METHODS, symbolOf } from '../shop.constants';
import { PushService } from '../../notify/push.service';
import { CouponsService } from '../coupons/coupons.service';
import { ShopCartsService } from '../carts/carts';
import { LoyaltyService } from '../loyalty/loyalty';
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly webhooks: WebhooksService,
    private readonly merchant: MerchantNotifier,
    private readonly emails: StoreEmails,
    private readonly push: PushService,
    private readonly coupons: CouponsService,
    private readonly carts: ShopCartsService,
    private readonly loyalty: LoyaltyService,
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
        void this.emails.newOrder(store, placed.order);
        void this.push.toCompany(store.companyId, {
          title: `طلب جديد ${placed.order.ref} — ${store.name}`,
          body: `${placed.order.custName || 'عميل'} · ${Number(placed.order.total).toLocaleString('en-US')} ${symbolOf(store.country)}`,
          link: `/orders/${placed.order.id}`,
          kind: 'order',
          data: { orderId: placed.order.id, storeId: store.id },
        }).catch(() => undefined);
        return placed;
      } catch (err) {
        // تصادم مرجع نادر (٣٢^٥) — نعيد بمرجع جديد بدل فشل الطلب
        if ((err as { code?: string }).code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }
    throw new ConflictException('تعذّر توليد رقم مرجعي فريد');
  }

  /**
   * طلب يدويّ من لوحة التاجر أو التطبيق. لا إشعار «طلب جديد» للتاجر نفسه (هو من أدخله)،
   * لكن webhooks تُبلَّغ كأي طلب ليصل لأنظمته الأخرى.
   */
  async createManual(ctx: TenantContext, storeId: string, dto: ManualOrderDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    if (!dto.name?.trim() && !dto.phone?.trim()) throw new BadRequestException('اكتب اسم العميل أو جواله');
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const placed = await this.placeOnce(store, dto, {
          deliveryFee: dto.deliveryFee,
          extraDiscount: dto.extraDiscount ?? 0,
          paid: dto.paid === true,
          confirm: dto.confirm !== false,
          pointsUsed: dto.pointsUsed ?? 0,
        });
        this.notify(store, 'order.created', placed.order);
        return this.view(placed.order, store);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }
    throw new ConflictException('تعذّر توليد رقم مرجعي فريد');
  }

  private async placeOnce(
    store: ShopStore,
    dto: PlaceOrderDto,
    manual?: { deliveryFee?: number; extraDiscount: number; paid: boolean; confirm: boolean; pointsUsed?: number },
  ) {
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
    // اليدوي: التاجر يختار من كل الطرق المعروفة (قد يدفع العميل في المحل بطريقة لا يعرضها المتجر)
    const method = dto.payMethod && (allowed.includes(dto.payMethod) || (manual && dto.payMethod in PAY_METHODS)) ? dto.payMethod : 'cod';

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
        cost: number;
      }> = [];

      for (const { id, variantId, qty } of wanted.values()) {
        const product = await tx.shopProduct.findFirst({
          // اليدوي يبيع حتى المنتج المخفي من الواجهة (يُطلب هاتفيًا)
          where: { id, storeId, ...(manual ? {} : { live: true }) },
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
          cost: product.costPrice ?? 0,
        });
      }

      const subtotal = priced.reduce((a, l) => a + l.price * l.qty, 0);
      const delivery = manual?.deliveryFee ?? deliveryFor(store, subtotal, zone);

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

      // القسيمة بعد معرفة العميل (حدّ الاستخدام لكل رقم) وقبل إنشاء الطلب؛
      // فشلها يُرجع المعاملة كلها فلا يُحجز استخدام لطلب لم يُسجَّل
      const coupon = dto.coupon?.trim()
        ? await this.coupons.consume(tx, store, dto.coupon, subtotal, delivery, customerId)
        : null;
      const points = manual?.pointsUsed ?? 0;
      if (points > 0 && !customerId) throw new BadRequestException('اكتب جوال العميل لصرف رصيد مكافآته');
      const discount = Math.min(subtotal + delivery, (coupon?.discount ?? 0) + (manual?.extraDiscount ?? 0) + points);
      const total = Math.max(0, subtotal + delivery - discount);

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
          payStatus: manual?.paid ? PayStatus.Paid : method === 'cod' ? PayStatus.None : PayStatus.Await,
          custName: dto.name ?? '',
          custPhone: rawPhone,
          custAddress: dto.address ?? '',
          note: dto.note ?? '',
          subtotal,
          deliveryFee: delivery,
          couponCode: coupon?.code ?? '',
          discount,
          total,
          status: manual?.confirm ? OrderStatus.Confirmed : OrderStatus.Wait,
          source: manual ? 'manual' : 'store',
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
              cost: l.cost,
            })),
          },
        },
        include: { items: true },
      });

      if (points > 0 && customerId) await this.loyalty.redeem(tx, storeId, companyId, customerId, points, order.id, order.ref);
      // سلة الرقم نفسه صارت طلبًا
      await this.carts.recover(tx, storeId, phoneKey, order.id);

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
        discount,
        coupon: coupon?.code ?? '',
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
    { status, page, q }: { status?: number; page?: number; q?: string },
  ) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);

    const where = this.filter(storeId, status, q);
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
      // أعداد التبويبات تتبع البحث: «مؤكد (٢)» تعني من نتائج البحث
      db.shopOrder.groupBy({ by: ['status'], where: this.filter(storeId, undefined, q), _count: { _all: true } }),
    ]);

    const counts: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
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

  /** الحالة والبحث برقم الطلب أو اسم العميل أو جزء من جواله (بأي صيغة كتبها) */
  private filter(storeId: string, status?: number, q?: string): Prisma.ShopOrderWhereInput {
    const term = q?.trim().slice(0, 60) ?? '';
    const digits = term.replace(/\D/g, '').replace(/^0+/, '');
    const phone = digits.length >= 3
      ? [{ custPhone: { contains: digits } }, { customer: { phone: { contains: digits } } }]
      : [];
    return {
      storeId,
      ...(status !== undefined && status in ORDER_NEXT ? { status } : {}),
      ...(term
        ? {
            OR: [
              { ref: { contains: term, mode: 'insensitive' as const } },
              { custName: { contains: term, mode: 'insensitive' as const } },
              ...phone,
            ],
          }
        : {}),
    };
  }

  /** تصدير السجل بالمرشّح نفسه — حدّ يكفي متجرًا كبيرًا ولا يُثقل الخادم */
  async export(ctx: TenantContext, storeId: string, { status, q }: { status?: number; q?: string }) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const rows = await db.shopOrder.findMany({
      where: this.filter(storeId, status, q),
      orderBy: { createdAt: 'desc' },
      take: ORDERS_EXPORT_MAX,
      include: { items: true },
    });
    return {
      orders: rows.map((o) => ({
        ref: o.ref, createdAt: o.createdAt, status: o.status, payMethod: o.payMethod, payStatus: o.payStatus,
        custName: o.custName, custPhone: o.custPhone, custAddress: o.custAddress, zoneName: o.zoneName, note: o.note,
        subtotal: o.subtotal, deliveryFee: o.deliveryFee, couponCode: o.couponCode, discount: o.discount, total: o.total,
        items: o.items.map((i) => ({ name: i.name, qty: i.qty })),
      })),
      truncated: rows.length === ORDERS_EXPORT_MAX,
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
  async advance(ctx: TenantContext, storeId: string, id: string, to: OrderStatus, reason = '') {
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
        // الطلب الملغى لا يستهلك القسيمة
        await this.coupons.release(tx, storeId, order.couponCode);
      }
      // المكافآت: نسبة المتجر من إجمالي الطلب لرصيد العميل عند الاكتمال
      if (to === OrderStatus.Done) await this.loyalty.earn(tx, order, store.loyaltyRate);
      return tx.shopOrder.update({
        where: { id },
        // سبب الإلغاء يراه العميل في صفحة تتبّع طلبه
        data: { status: to, ...(to === OrderStatus.Off ? { cancelReason: reason.trim().slice(0, 200) } : {}) },
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
        status: { in: SOLD_STATUSES },
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
      id: o.id,
      ref: o.ref,
      status: o.status,
      payMethod: o.payMethod,
      payStatus: o.payStatus,
      // تعليمات التحويل ما دام الدفع لم يكتمل — العميل قد يعود ليدفع لاحقًا
      payNote: awaiting ? store.payNote : '',
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      couponCode: o.couponCode,
      discount: o.discount,
      total: o.total,
      cancelReason: o.status === OrderStatus.Off ? o.cancelReason : '',
      // الشحن بعد خروجه فقط — الشركة والرقم ورابط التتبّع
      shipping: [OrderStatus.Shipped, OrderStatus.Done].includes(o.status) && (o.carrierName || o.trackingNo)
        ? { carrier: o.carrierName, trackingNo: o.trackingNo, url: o.trackUrl }
        : null,
      // رصيد المكافآت لصاحب الطلب — يراه من رابط طلبه
      points: store.loyaltyRate > 0 && o.customerId ? (await this.prisma.shopCustomer.findUnique({ where: { id: o.customerId }, select: { points: true } }))?.points ?? 0 : null,
      // المعرّف لتقييم السطر بعد الاستلام — لا يكشف شيئًا لا يملكه صاحب الرقم
      items: o.items.map((i) => ({ id: i.id, productId: i.productId, name: i.name, variant: i.variant, price: i.price, qty: i.qty })),
      createdAt: o.createdAt,
    };
  }
}

