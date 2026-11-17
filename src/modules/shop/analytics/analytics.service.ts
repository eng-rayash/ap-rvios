import { Injectable } from '@nestjs/common';
import { ShopStore } from '@prisma/client';
import { createHash } from 'node:crypto';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { OrderStatus, SOLD_STATUSES } from '../shop.constants';
import { cleanPath, deviceOf, isBot, localHour, sourceOf, statUpsert, StatRow } from './visitor-stats';

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

  private static readonly SOLD = SOLD_STATUSES;

  // ═══ الزيارات (عامّ) ═════════════════════════════════════
  /**
   * زوّار فريدون يوميًا: بصمة مجزّأة تمنع تضخيم الرقم بكل تحديث للصفحة، بلا
   * تخزين أي بيانات تعريفية. الملح من البيئة (`VISIT_SALT`) وثابت في الإنتاج
   * ليبقى العدّ صحيحًا بعد إعادة التشغيل.
   */
  async recordVisit(store: ShopStore, ip: string, userAgent: string, extra: { path?: string; ref?: string } = {}) {
    if (isBot(userAgent)) return { ok: true, counted: false };
    const day = ymd(new Date());
    const path = cleanPath(extra.path);
    const salt = process.env.VISIT_SALT ?? 'dev-visit-salt';
    const mark = createHash('sha256')
      .update(`${store.id}|${day}|${ip}|${userAgent}|${salt}`)
      .digest('hex')
      .slice(0, 32);

    const seen = await this.prisma.shopVisitMark.findUnique({ where: { mark } });
    // كل صفحة تُعدّ مشاهدة؛ والجهاز والمصدر وساعة الوصول للزائر الجديد في يومه فقط
    const stats: StatRow[] = [{ dim: 'path', key: path }];
    if (!seen) {
      const own = ['rvios.store', 'rvios.com', 'localhost', ...(store.customDomain ? [store.customDomain] : [])];
      stats.push(
        { dim: 'device', key: deviceOf(userAgent) },
        { dim: 'source', key: sourceOf(extra.ref, own) },
        { dim: 'hour', key: String(localHour(store.country)) },
      );
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        if (!seen) await tx.shopVisitMark.create({ data: { mark, day } });
        await tx.shopVisit.upsert({
          where: { storeId_day: { storeId: store.id, day } },
          create: { companyId: store.companyId, storeId: store.id, day, count: seen ? 0 : 1, views: 1 },
          update: { views: { increment: 1 }, ...(seen ? {} : { count: { increment: 1 } }) },
        });
        for (const r of stats) await statUpsert(tx, store, day, r);
      });
    } catch (e) {
      // زيارتان متزامنتان للزائر نفسه: الثانية تصطدم بالبصمة — لا تُعدّ مرتين
      if ((e as { code?: string }).code === 'P2002') return { ok: true, counted: false };
      throw e;
    }
    if (seen) return { ok: true, counted: false };
    // البصمات لا تُحتفظ أكثر من يومين
    if (Math.random() < 0.02) {
      await this.prisma.shopVisitMark.deleteMany({
        where: { day: { lt: ymd(new Date(Date.now() - 2 * DAY)) } },
      });
      // المجاميع تكفي لسنة وشهر من المقارنات
      await this.prisma.shopVisitStat.deleteMany({ where: { day: { lt: ymd(new Date(Date.now() - 400 * DAY)) } } });
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
  // ═══ تقرير الزوار ═══════════════════════════════════════
  async visitors(ctx: TenantContext, storeId: string, rangeDays: number) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const n = Math.min(365, Math.max(1, rangeDays || 30));
    const days = daysBack(n);
    const [visits, stats] = await Promise.all([
      db.shopVisit.findMany({ where: { storeId, day: { gte: days[0] } } }),
      db.shopVisitStat.groupBy({ by: ['dim', 'key'], where: { storeId, day: { gte: days[0] } }, _sum: { count: true } }),
    ]);
    const by = new Map(visits.map((v) => [v.day, v]));
    const series = days.map((d) => ({ day: d, visitors: by.get(d)?.count ?? 0, views: by.get(d)?.views ?? 0 }));
    const visitors = series.reduce((a, s) => a + s.visitors, 0);
    const views = series.reduce((a, s) => a + s.views, 0);
    const dim = (d: string) => stats.filter((s) => s.dim === d).map((s) => ({ key: s.key, count: s._sum.count ?? 0 })).sort((a, b) => b.count - a.count);

    const hours = Array<number>(24).fill(0);
    for (const h of dim('hour')) hours[Number(h.key)] = h.count;
    const weekdays = Array<number>(7).fill(0);
    for (const s of series) weekdays[new Date(`${s.day}T12:00:00Z`).getUTCDay()] += s.visitors;

    // صفحات المنتجات بأسمائها
    const pages = dim('path').slice(0, 12);
    const ids = pages.map((p) => /^\/p\/([0-9a-f-]{36})$/.exec(p.key)?.[1]).filter((x): x is string => !!x);
    const names = new Map(
      (ids.length ? await db.shopProduct.findMany({ where: { id: { in: ids }, storeId }, select: { id: true, name: true } }) : []).map((p) => [p.id, p.name]),
    );
    return {
      range: { days: n, from: days[0], to: days[days.length - 1] },
      totals: { visitors, views, avgDaily: Math.round((visitors / n) * 10) / 10, pagesPerVisit: visitors ? Math.round((views / visitors) * 10) / 10 : 0 },
      series,
      devices: Object.fromEntries(dim('device').map((d) => [d.key, d.count])) as Record<string, number>,
      hours,
      weekdays,
      pages: pages.map((p) => ({ path: p.key, views: p.count, name: names.get(/^\/p\/(.+)$/.exec(p.key)?.[1] ?? '') ?? null })),
      sources: dim('source').slice(0, 12).map((s) => ({ source: s.key, visitors: s.count })),
    };
  }

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
    const byStatus: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
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
      select: { productId: true, name: true, qty: true, price: true, cost: true },
    });
    // الربح من الأسطر معروفة التكلفة وحدها، ومعه نسبة تغطيتها من المبيعات — لا ربح مخترع
    let costed = 0;
    let costTotal = 0;
    let itemsRevenue = 0;
    for (const it of items) {
      itemsRevenue += it.qty * it.price;
      if (it.cost > 0) { costed += it.qty * it.price; costTotal += it.qty * it.cost; }
    }
    const prod = new Map<string, { productId: string | null; name: string; qty: number; revenue: number; profit: number | null }>();
    for (const it of items) {
      const key = it.productId ?? `n:${it.name}`;
      const row = prod.get(key) ?? { productId: it.productId, name: it.name, qty: 0, revenue: 0, profit: null };
      row.qty += it.qty;
      row.revenue += it.qty * it.price;
      if (it.cost > 0) row.profit = (row.profit ?? 0) + it.qty * (it.price - it.cost);
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
        conversion: totalVisits ? Math.min(100, Math.round((orders.length / totalVisits) * 1000) / 10) : 0,
        cancelRate: orders.length ? Math.round((byStatus[OrderStatus.Off] / orders.length) * 1000) / 10 : 0,
      },
      profit: {
        // قبل التوصيل والخصم: هامش المنتجات نفسها
        amount: costed - costTotal,
        margin: costed ? Math.round(((costed - costTotal) / costed) * 1000) / 10 : 0,
        coverage: itemsRevenue ? Math.round((costed / itemsRevenue) * 100) : 0,
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
