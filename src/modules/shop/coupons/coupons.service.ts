import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShopCoupon, ShopStore } from '@prisma/client';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { MAX_COUPONS, PLAN_NAME, symbolOf } from '../shop.constants';
import { CouponDto, CouponKind, COUPON_CODE } from './coupons.dto';

/** خطأ يراه العميل كما هو (رمز منتهٍ، حدّ أدنى…) */
export class CouponError extends BadRequestException {}

type Tx = Prisma.TransactionClient;

export const normCode = (c: string) => c.trim().toUpperCase();

/**
 * قيمة الخصم — دالة واحدة للمعاينة وللطلب كي لا يختلف ما يراه العميل عمّا يدفعه.
 * الخصم لا يتجاوز المجموع (ولا رسم التوصيل في «توصيل مجاني»)، فلا إجمالي سالبًا.
 */
export function couponDiscount(
  c: Pick<ShopCoupon, 'kind' | 'value' | 'maxDiscount'>,
  subtotal: number,
  delivery: number,
): number {
  if (c.kind === 'ship') return Math.max(0, delivery);
  if (c.kind === 'amount') return Math.min(subtotal, Math.max(0, c.value));
  let d = Math.floor((subtotal * Math.min(100, Math.max(0, c.value))) / 100);
  if (c.maxDiscount > 0) d = Math.min(d, c.maxDiscount);
  return Math.min(subtotal, d);
}

/** وصف قصير للعميل وللتاجر: «خصم ١٠٪» · «خصم 5,000 ر.ي» · «توصيل مجاني» */
export function couponLabel(c: Pick<ShopCoupon, 'kind' | 'value' | 'maxDiscount'>, country: string): string {
  const cur = symbolOf(country);
  if (c.kind === 'ship') return 'توصيل مجاني';
  if (c.kind === 'amount') return `خصم ${c.value.toLocaleString('en-US')} ${cur}`;
  return `خصم ${c.value}%${c.maxDiscount > 0 ? ` (حتى ${c.maxDiscount.toLocaleString('en-US')} ${cur})` : ''}`;
}

/**
 * يتحقق من صلاحية القسيمة الآن (التاريخ، التفعيل، العدد الكلي، الحد الأدنى).
 * حدّ العميل الواحد يُفحص في الطلب فقط لأنه يحتاج رقم الجوال.
 */
function assertUsable(c: ShopCoupon | null, subtotal: number, country: string): asserts c is ShopCoupon {
  if (!c || !c.active) throw new CouponError('رمز الخصم غير صحيح');
  const now = Date.now();
  if (c.startsAt && c.startsAt.getTime() > now) throw new CouponError('رمز الخصم لم يبدأ بعد');
  if (c.endsAt && c.endsAt.getTime() < now) throw new CouponError('انتهت صلاحية رمز الخصم');
  if (c.usageLimit > 0 && c.used >= c.usageLimit) throw new CouponError('نفد رمز الخصم');
  if (c.minSubtotal > 0 && subtotal < c.minSubtotal) {
    throw new CouponError(
      `رمز الخصم يعمل لطلب من ${c.minSubtotal.toLocaleString('en-US')} ${symbolOf(country)} فأكثر`,
    );
  }
}

@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  // ═══ لوحة التاجر ═════════════════════════════════════════

  async list(ctx: TenantContext, storeId: string) {
    const { store, plan, limits } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const rows = await db.shopCoupon.findMany({
      where: { storeId },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    });
    // أثر كل قسيمة: الطلبات غير الملغاة ومجموع ما خُصم بها
    const stats = await db.shopOrder.groupBy({
      by: ['couponCode'],
      where: { storeId, couponCode: { in: rows.map((r) => r.code) }, status: { not: 3 } },
      _count: { _all: true },
      _sum: { discount: true, total: true },
    });
    const by = new Map(stats.map((s) => [s.couponCode, s]));
    return {
      coupons: rows.map((c) => ({
        ...c,
        label: couponLabel(c, store.country),
        orders: by.get(c.code)?._count._all ?? 0,
        discounted: by.get(c.code)?._sum.discount ?? 0,
        revenue: by.get(c.code)?._sum.total ?? 0,
      })),
      limit: limits.coupons,
      plan,
      planName: PLAN_NAME[plan] ?? plan,
      currency: symbolOf(store.country),
    };
  }

  /** المفعّلة معًا محدودة بالباقة — المحفوظة غير المفعّلة لا تُحسب */
  private async assertActiveRoom(ctx: TenantContext, storeId: string, excludeId?: string) {
    const { plan, limits } = await this.access.require(ctx, storeId);
    if (limits.coupons === null) return;
    const db = this.prisma.forTenant(ctx.companyId);
    const active = await db.shopCoupon.count({
      where: { storeId, active: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (active >= limits.coupons) {
      throw new BadRequestException(
        `باقة ${PLAN_NAME[plan] ?? plan} تسمح بـ ${limits.coupons} قسائم مفعّلة معًا — أوقف واحدة أو رقِّ باقتك`,
      );
    }
  }

  private shape(dto: CouponDto, current?: ShopCoupon) {
    const kind = (dto.kind ?? current?.kind ?? 'percent') as CouponKind;
    const value = dto.value ?? current?.value ?? 0;
    if (kind === 'percent' && (value < 1 || value > 100)) throw new BadRequestException('النسبة بين ١ و١٠٠');
    if (kind === 'amount' && value < 1) throw new BadRequestException('اكتب مبلغ الخصم');
    const startsAt = dto.startsAt === undefined ? current?.startsAt ?? null : dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt === undefined ? current?.endsAt ?? null : dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('تاريخ الانتهاء بعد تاريخ البدء');
    return {
      kind,
      value: kind === 'ship' ? 0 : value,
      minSubtotal: dto.minSubtotal ?? current?.minSubtotal ?? 0,
      maxDiscount: kind === 'percent' ? dto.maxDiscount ?? current?.maxDiscount ?? 0 : 0,
      usageLimit: dto.usageLimit ?? current?.usageLimit ?? 0,
      perCustomer: dto.perCustomer ?? current?.perCustomer ?? 0,
      startsAt,
      endsAt,
      note: (dto.note ?? current?.note ?? '').trim(),
    };
  }

  async create(ctx: TenantContext, storeId: string, dto: CouponDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const code = normCode(dto.code ?? '');
    if (!COUPON_CODE.test(code)) throw new BadRequestException('اكتب رمز القسيمة (٣ أحرف لاتينية أو أرقام فأكثر)');
    if ((await db.shopCoupon.count({ where: { storeId } })) >= MAX_COUPONS) {
      throw new BadRequestException(`بلغتَ حدّ ${MAX_COUPONS} قسيمة — احذف القديمة`);
    }
    const active = dto.active ?? true;
    if (active) await this.assertActiveRoom(ctx, storeId);
    try {
      const c = await db.shopCoupon.create({
        data: tenantCreate<Prisma.ShopCouponUncheckedCreateInput>({ storeId, code, active, ...this.shape(dto) }),
      });
      return { ...c, label: couponLabel(c, store.country) };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('هذا الرمز مستخدم في متجرك');
      throw e;
    }
  }

  private async coupon(ctx: TenantContext, storeId: string, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const c = await db.shopCoupon.findFirst({ where: { id, storeId } });
    if (!c) throw new NotFoundException('القسيمة غير موجودة');
    return c;
  }

  async update(ctx: TenantContext, storeId: string, id: string, dto: CouponDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const current = await this.coupon(ctx, storeId, id);
    const db = this.prisma.forTenant(ctx.companyId);
    // الرمز لا يتغيّر بعد استخدامه: الطلبات القديمة تشير إليه نصًّا
    let code = current.code;
    if (dto.code !== undefined && normCode(dto.code) !== current.code) {
      if (current.used > 0) throw new BadRequestException('لا يُغيَّر رمز قسيمة استُخدمت — أنشئ قسيمة جديدة');
      code = normCode(dto.code);
    }
    if (dto.active === true && !current.active) await this.assertActiveRoom(ctx, storeId, id);
    try {
      const c = await db.shopCoupon.update({
        where: { id },
        data: { code, ...(dto.active !== undefined ? { active: dto.active } : {}), ...this.shape(dto, current) },
      });
      return { ...c, label: couponLabel(c, store.country) };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('هذا الرمز مستخدم في متجرك');
      throw e;
    }
  }

  /** الطلبات تحتفظ بالرمز والخصم نصًّا، فالحذف لا يغيّر ما بيع */
  async remove(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.coupon(ctx, storeId, id);
    const db = this.prisma.forTenant(ctx.companyId);
    await db.shopCoupon.delete({ where: { id } });
    return { ok: true };
  }

  // ═══ واجهة المتجر ═════════════════════════════════════════

  /** هل في المتجر قسيمة مفعّلة؟ — حقل الرمز في السلة يظهر فقط حينها */
  async hasActive(storeId: string): Promise<boolean> {
    const now = new Date();
    const n = await this.prisma.shopCoupon.count({
      where: {
        storeId,
        active: true,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
    });
    return n > 0;
  }

  /** معاينة للعميل — لا تحجز شيئًا */
  async check(store: ShopStore, code: string, subtotal: number, delivery: number) {
    const c = await this.prisma.shopCoupon.findUnique({
      where: { storeId_code: { storeId: store.id, code: normCode(code) } },
    });
    assertUsable(c, subtotal, store.country);
    return {
      code: c.code,
      kind: c.kind,
      value: c.value,
      maxDiscount: c.maxDiscount,
      minSubtotal: c.minSubtotal,
      label: couponLabel(c, store.country),
      discount: couponDiscount(c, subtotal, delivery),
    };
  }

  /**
   * داخل معاملة الطلب: يتحقق ويحجز استخدامًا ذرّيًا (زيادة شرطية) — طلبان
   * متزامنان على آخر استخدام لا ينجحان معًا.
   */
  async consume(
    tx: Tx,
    store: ShopStore,
    code: string,
    subtotal: number,
    delivery: number,
    customerId: string | null,
  ): Promise<{ code: string; discount: number }> {
    const c = await tx.shopCoupon.findUnique({
      where: { storeId_code: { storeId: store.id, code: normCode(code) } },
    });
    assertUsable(c, subtotal, store.country);

    if (c.perCustomer > 0) {
      if (!customerId) throw new CouponError('اكتب رقم جوالك لاستخدام رمز الخصم');
      const mine = await tx.shopOrder.count({
        where: { storeId: store.id, customerId, couponCode: c.code, status: { not: 3 } },
      });
      if (mine >= c.perCustomer) throw new CouponError('استخدمتَ رمز الخصم هذا من قبل');
    }

    const r = await tx.shopCoupon.updateMany({
      where: { id: c.id, ...(c.usageLimit > 0 ? { used: { lt: c.usageLimit } } : {}) },
      data: { used: { increment: 1 } },
    });
    if (!r.count) throw new CouponError('نفد رمز الخصم');
    return { code: c.code, discount: couponDiscount(c, subtotal, delivery) };
  }

  /** إلغاء طلب يعيد استخدامه للقسيمة (إن بقيت) */
  async release(tx: Tx, storeId: string, code: string) {
    if (!code) return;
    await tx.shopCoupon.updateMany({
      where: { storeId, code, used: { gt: 0 } },
      data: { used: { decrement: 1 } },
    });
  }
}
