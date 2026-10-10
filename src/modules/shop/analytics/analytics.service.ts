import { Injectable } from '@nestjs/common';
import { ShopStore } from '@prisma/client';
import { createHash } from 'node:crypto';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { OrderStatus } from '../shop.constants';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** أيام من `from` حتى اليوم، بالترتيب — لتُملأ الأيام الفارغة بأصفار. */
function daysBack(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(ymd(new Date(Date.now() - i * DAY)));
  return out;
}

/**
 * نظرة عامة وتحليلات وتقارير المتجر — كلها تُحسب بالاستعلام من الطلبات
 * والزيارات، لا من عدّادات مخزَّنة: العدّاد المخزَّن ينحرف بصمت.
 *
 * «المبيعات» = طلبات مؤكدة أو مكتملة فقط؛ الملغى والمعلّق لا يُحتسبان
 * إيرادًا. الأيام بتوقيت UTC.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  private static readonly SOLD = [OrderStatus.Confirmed, OrderStatus.Done];

  // ═══ الزيارات (عامّ) ═════════════════════════════════════
  /**
   * زوّار فريدون يوميًا: بصمة مجزّأة تمنع تضخيم الرقم بكل تحديث للصفحة، بلا
   * تخزين أي بيانات تعريفية. الملح من البيئة (`VISIT_SALT`) وثابت في الإنتاج
   * ليبقى العدّ صحيحًا بعد إعادة التشغيل.
   */
  async recordVisit(store: ShopStore, ip: string, userAgent: string) {
    const day = ymd(new Date());
    const salt = process.env.VISIT_SALT ?? 'dev-visit-salt';
    const mark = createHash('sha256')
      .update(`${store.id}|${day}|${ip}|${userAgent}|${salt}`)
      .digest('hex')
      .slice(0, 32);

    const seen = await this.prisma.shopVisitMark.findUnique({ where: { mark } });
    if (seen) return { ok: true, counted: false };

    await this.prisma.$transaction([
      this.prisma.shopVisitMark.create({ data: { mark, day } }),
      this.prisma.shopVisit.upsert({
        where: { storeId_day: { storeId: store.id, day } },
        create: { companyId: store.companyId, storeId: store.id, day, count: 1 },
        update: { count: { increment: 1 } },
      }),
    ]);
    // البصمات لا تُحتفظ أكثر من يومين
    if (Math.random() < 0.02) {
      await this.prisma.shopVisitMark.deleteMany({
        where: { day: { lt: ymd(new Date(Date.now() - 2 * DAY)) } },
      });
    }
    return { ok: true, counted: true };
  }

  // ═══ النظرة العامة (§٣.٣ — الطلبات المعلّقة أولًا) ═══════
  async overview(ctx: TenantContext, storeId: string) {
    const { plan, limits } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);

    const days = daysBack(7);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [pending, liveProducts, productCount, visits, ordersWeek, monthSales, recent, lowStock] =
      await Promise.all([
        db.shopOrder.count({ where: { storeId, status: OrderStatus.Wait } }),
        db.shopProduct.count({ where: { storeId, live: true } }),
        db.shopProduct.count({ where: { storeId } }),
        db.shopVisit.findMany({ where: { storeId, day: { gte: days[0] } } }),
        db.shopOrder.findMany({
          where: { storeId, createdAt: { gte: new Date(`${days[0]}T00:00:00Z`) } },
          select: { createdAt: true },
        }),
        db.shopOrder.aggregate({
          where: {
            storeId,
            status: { in: AnalyticsService.SOLD },
            createdAt: { gte: monthStart },
          },
          _sum: { total: true },
        }),
        db.shopOrder.findMany({
          where: { storeId },
          orderBy: { createdAt: 'desc' },
          take: 4,
          include: { items: true },
        }),
        this.lowStock(ctx, storeId, 5),
      ]);

    const visitBy = new Map(visits.map((v) => [v.day, v.count]));
    const orderBy = new Map<string, number>();
    for (const o of ordersWeek) {
      const d = ymd(o.createdAt);
      orderBy.set(d, (orderBy.get(d) ?? 0) + 1);
    }

    const max = limits.products;
    return {
      kpis: {
        pending,
        visits: days.reduce((a, d) => a + (visitBy.get(d) ?? 0), 0),
        products: liveProducts,
        confirmed: monthSales._sum.total ?? 0,
      },
      chart: days.map((d) => ({ day: d, visits: visitBy.get(d) ?? 0, orders: orderBy.get(d) ?? 0 })),
      capacity: {
        used: productCount,
        max,
        pct: max === null ? 0 : Math.min(100, Math.round((productCount / max) * 100)),
        plan,
      },
      recent,
      lowStock,
    };
  }

  // ═══ المخزون المنخفض ═════════════════════════════════════
  /** منتجات كميتها أقل من حدّها (أو من `fallback` حين لا حدّ مضبوط). */
  async lowStock(ctx: TenantContext, storeId: string, fallback = 5) {
    const db = this.prisma.forTenant(ctx.companyId);
    const rows = await db.shopProduct.findMany({
      where: { storeId, live: true },
      select: { id: true, name: true, qty: true, lowStock: true, image: true },
      orderBy: { qty: 'asc' },
      take: 200,
    });
    return rows
      .filter((p) => p.qty <= (p.lowStock > 0 ? p.lowStock : fallback))
      .slice(0, 20);
  }

  // ═══ التحليلات والتقارير ═════════════════════════════════
  async analytics(ctx: TenantContext, storeId: string, rangeDays: number) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const n = Math.min(365, Math.max(7, rangeDays || 30));
    const days = daysBack(n);
    const from = new Date(`${days[0]}T00:00:00Z`);

    const orders = await db.shopOrder.findMany({
      where: { storeId, createdAt: { gte: from } },
      select: {
        id: true, createdAt: true, total: true, status: true, payMethod: true,
        zoneName: true, customerId: true,
      },
    });
    const visits = await db.shopVisit.findMany({ where: { storeId, day: { gte: days[0] } } });
    const visitBy = new Map(visits.map((v) => [v.day, v.count]));

    const isSold = (s: number) => AnalyticsService.SOLD.includes(s);

    // ── سلسلة يومية ──
    const series = days.map((d) => ({ day: d, orders: 0, revenue: 0, visits: visitBy.get(d) ?? 0 }));
    const idx = new Map(series.map((s, i) => [s.day, i]));
    for (const o of orders) {
      const i = idx.get(ymd(o.createdAt));
      if (i === undefined) continue;
      series[i].orders += 1;
      if (isSold(o.status)) series[i].revenue += o.total;
    }

    // ── مجاميع ──
    const sold = orders.filter((o) => isSold(o.status));
    const revenue = sold.reduce((a, o) => a + o.total, 0);
    const totalVisits = series.reduce((a, s) => a + s.visits, 0);
    const byStatus: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const byPay: Record<string, { orders: number; revenue: number }> = {};
    const byZone: Record<string, { orders: number; revenue: number }> = {};
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      const pay = (byPay[o.payMethod] ??= { orders: 0, revenue: 0 });
      pay.orders += 1;
      if (isSold(o.status)) pay.revenue += o.total;
      const zone = o.zoneName || 'بلا منطقة';
      const z = (byZone[zone] ??= { orders: 0, revenue: 0 });
      z.orders += 1;
      if (isSold(o.status)) z.revenue += o.total;
    }

    // ── أفضل المنتجات (من أسطر طلبات مؤكدة/مكتملة في الفترة) ──
    const items = await db.shopOrderItem.findMany({
      where: {
        storeId,
        order: { createdAt: { gte: from }, status: { in: AnalyticsService.SOLD } },
      },
      select: { productId: true, name: true, qty: true, price: true },
    });
    const prod = new Map<string, { productId: string | null; name: string; qty: number; revenue: number }>();
    for (const it of items) {
      const key = it.productId ?? `n:${it.name}`;
      const row = prod.get(key) ?? { productId: it.productId, name: it.name, qty: 0, revenue: 0 };
      row.qty += it.qty;
      row.revenue += it.qty * it.price;
      prod.set(key, row);
    }
    const topProducts = [...prod.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

    // ── العملاء: جدد مقابل عائدين (طلبات هذه الفترة) ──
    const customerIds = [...new Set(orders.map((o) => o.customerId).filter((c): c is string => !!c))];
    let returning = 0;
    if (customerIds.length) {
      const counts = await db.shopOrder.groupBy({
        by: ['customerId'],
        where: { storeId, customerId: { in: customerIds } },
        _count: { _all: true },
      });
      returning = counts.filter((c) => c._count._all > 1).length;
    }

    return {
      range: { days: n, from: days[0], to: days[days.length - 1] },
      totals: {
        orders: orders.length,
        soldOrders: sold.length,
        revenue,
        averageOrder: sold.length ? Math.round(revenue / sold.length) : 0,
        visits: totalVisits,
        // نسبة الطلبات إلى الزيارات الفريدة — مؤشر التحويل الأهم للتاجر
        conversion: totalVisits ? Math.round((orders.length / totalVisits) * 1000) / 10 : 0,
        cancelRate: orders.length ? Math.round((byStatus[OrderStatus.Off] / orders.length) * 1000) / 10 : 0,
      },
      series,
      byStatus,
      byPayMethod: byPay,
      byZone,
      topProducts,
      customers: {
        buyers: customerIds.length,
        returning,
        newBuyers: customerIds.length - returning,
      },
      lowStock: await this.lowStock(ctx, storeId),
    };
  }
}
