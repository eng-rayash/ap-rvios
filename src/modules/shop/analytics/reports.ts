import { BadRequestException, Controller, Get, Injectable, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { hideCost, ShopSection } from '../../../common/tenant/shop-sections';
import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { OrderStatus, SOLD_STATUSES } from '../shop.constants';
import { localHour } from './visitor-stats';
import { PlanFeature } from '../plan-feature.guard';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
/** التغيّر عن الفترة السابقة ٪ — null حين لا أساس للمقارنة */
const delta = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

type Line = { productId: string | null; name: string; qty: number; price: number; cost: number };
type Ord = {
  id: string; createdAt: Date; status: number; total: number; subtotal: number; deliveryFee: number; discount: number; walletPaid: number;
  payMethod: string; source: string; couponCode: string; zoneName: string; customerId: string | null; custName: string; custPhone: string; items: Line[];
};

/**
 * التقارير المفصّلة لفترة يختارها التاجر (حتى سنة): المبيعات مقارنةً بالفترة السابقة بالطول نفسه،
 * والطلبات، والمنتجات، والعملاء، والقسائم، والمخزون. كلها من الطلبات نفسها لا من عدّادات.
 */
@Injectable()
export class ShopReportsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  async report(ctx: TenantContext, storeId: string, fromS?: string, toS?: string) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const to = toS && DATE.test(toS) ? new Date(`${toS}T00:00:00Z`) : new Date(`${ymd(new Date())}T00:00:00Z`);
    const from = fromS && DATE.test(fromS) ? new Date(`${fromS}T00:00:00Z`) : new Date(to.getTime() - 29 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new BadRequestException('فترة غير صالحة');
    const days = Math.round((to.getTime() - from.getTime()) / DAY) + 1;
    if (days > 366) throw new BadRequestException('أطول فترة سنة واحدة');
    const end = new Date(to.getTime() + DAY);
    const prevFrom = new Date(from.getTime() - days * DAY);

    const select = {
      id: true, createdAt: true, status: true, total: true, subtotal: true, deliveryFee: true, discount: true, walletPaid: true,
      payMethod: true, source: true, couponCode: true, zoneName: true, customerId: true, custName: true, custPhone: true,
      items: { select: { productId: true, name: true, qty: true, price: true, cost: true } },
    } as const;
    const [orders, prevOrders, products, categories, visits] = await Promise.all([
      db.shopOrder.findMany({ where: { storeId, createdAt: { gte: from, lt: end } }, select }) as Promise<Ord[]>,
      db.shopOrder.findMany({ where: { storeId, createdAt: { gte: prevFrom, lt: from } }, select: { status: true, total: true, customerId: true } }),
      db.shopProduct.findMany({ where: { storeId }, select: { id: true, name: true, qty: true, price: true, costPrice: true, live: true, categoryId: true, createdAt: true } }),
      db.shopCategory.findMany({ where: { storeId }, select: { id: true, name: true } }),
      db.shopVisit.findMany({ where: { storeId, day: { gte: ymd(from), lte: ymd(to) } }, select: { count: true } }),
    ]);
    const isSold = (s: number) => SOLD_STATUSES.includes(s);
    const sold = orders.filter((o) => isSold(o.status));
    const prevSold = prevOrders.filter((o) => isSold(o.status));
    const revenue = sold.reduce((a, o) => a + o.total, 0);
    const prevRevenue = prevSold.reduce((a, o) => a + o.total, 0);

    // ── المبيعات ──
    const series = Array.from({ length: days }, (_, i) => ({ day: ymd(new Date(from.getTime() + i * DAY)), revenue: 0, orders: 0 }));
    const idx = new Map(series.map((s, i) => [s.day, i]));
    for (const o of sold) {
      const i = idx.get(ymd(o.createdAt));
      if (i !== undefined) { series[i].revenue += o.total; series[i].orders += 1; }
    }
    const byPay: Record<string, { orders: number; revenue: number }> = {};
    for (const o of sold) {
      byPay[o.payMethod] ??= { orders: 0, revenue: 0 };
      byPay[o.payMethod].orders += 1;
      byPay[o.payMethod].revenue += o.total;
    }
    const visitors = visits.reduce((a, v) => a + v.count, 0);
    const sales = {
      revenue, orders: sold.length, averageOrder: sold.length ? Math.round(revenue / sold.length) : 0,
      products: sold.reduce((a, o) => a + o.subtotal, 0), delivery: sold.reduce((a, o) => a + o.deliveryFee, 0),
      discounts: sold.reduce((a, o) => a + o.discount, 0), walletPaid: sold.reduce((a, o) => a + o.walletPaid, 0),
      // قبل بدء عدّ الزوار قد تسبق الطلباتُ الزوارَ — النسبة لا تتجاوز ١٠٠٪
      conversion: Math.min(100, pct(sold.length, visitors)), visitors,
      change: { revenue: delta(revenue, prevRevenue), orders: delta(sold.length, prevSold.length) },
      previous: { revenue: prevRevenue, orders: prevSold.length },
      series, byPayMethod: byPay,
    };

    // ── الطلبات ──
    const byStatus: Record<number, number> = {};
    const hours = Array<number>(24).fill(0);
    const weekdays = Array<number>(7).fill(0);
    const bySource: Record<string, number> = {};
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      hours[localHour(store.country, o.createdAt)] += 1;
      weekdays[o.createdAt.getUTCDay()] += 1;
      bySource[o.source] = (bySource[o.source] ?? 0) + 1;
    }
    const ordersReport = {
      total: orders.length, byStatus, hours, weekdays, bySource,
      cancelRate: pct(byStatus[OrderStatus.Off] ?? 0, orders.length),
      returnRate: pct(byStatus[OrderStatus.Returned] ?? 0, orders.length),
      pending: byStatus[OrderStatus.Wait] ?? 0,
    };

    // ── المنتجات ──
    const prodRows = new Map<string, { productId: string | null; name: string; qty: number; revenue: number; profit: number | null }>();
    const catOf = new Map(products.map((p) => [p.id, p.categoryId]));
    const byCat = new Map<string, { qty: number; revenue: number }>();
    for (const o of sold) for (const l of o.items) {
      const key = l.productId ?? `n:${l.name}`;
      const r = prodRows.get(key) ?? { productId: l.productId, name: l.name, qty: 0, revenue: 0, profit: null };
      r.qty += l.qty;
      r.revenue += l.qty * l.price;
      if (l.cost > 0) r.profit = (r.profit ?? 0) + l.qty * (l.price - l.cost);
      prodRows.set(key, r);
      const cat = (l.productId && catOf.get(l.productId)) || 'none';
      const c = byCat.get(cat) ?? { qty: 0, revenue: 0 };
      c.qty += l.qty; c.revenue += l.qty * l.price;
      byCat.set(cat, c);
    }
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const soldIds = new Set([...prodRows.values()].map((r) => r.productId).filter(Boolean));
    const productsReport = {
      top: [...prodRows.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 20),
      // منتجات معروضة لم يُبع منها شيء في الفترة (والأقدم من بدايتها، كي لا يُحسب الجديد راكدًا)
      unsold: products.filter((p) => p.live && !soldIds.has(p.id) && p.createdAt < from).map((p) => ({ id: p.id, name: p.name, qty: p.qty, price: p.price })).slice(0, 30),
      byCategory: [...byCat.entries()].map(([id, v]) => ({ id, name: id === 'none' ? 'بلا تصنيف' : catName.get(id) ?? 'تصنيف محذوف', ...v })).sort((a, b) => b.revenue - a.revenue),
      unitsSold: [...prodRows.values()].reduce((a, r) => a + r.qty, 0),
    };

    // ── العملاء ──
    const firstOrder = new Map<string, Date>();
    if (sold.some((o) => o.customerId)) {
      const firsts = await db.shopOrder.groupBy({ by: ['customerId'], where: { storeId, customerId: { in: [...new Set(sold.map((o) => o.customerId).filter((x): x is string => !!x))] }, status: { in: SOLD_STATUSES } }, _min: { createdAt: true } });
      for (const f of firsts) if (f.customerId && f._min.createdAt) firstOrder.set(f.customerId, f._min.createdAt);
    }
    const spend = new Map<string, { id: string; name: string; phone: string; orders: number; spent: number }>();
    for (const o of sold) {
      if (!o.customerId) continue;
      const r = spend.get(o.customerId) ?? { id: o.customerId, name: o.custName, phone: o.custPhone, orders: 0, spent: 0 };
      r.orders += 1; r.spent += o.total; r.name ||= o.custName;
      spend.set(o.customerId, r);
    }
    const buyers = [...spend.keys()];
    const newBuyers = buyers.filter((id) => (firstOrder.get(id) ?? from) >= from).length;
    const byZone: Record<string, { orders: number; revenue: number }> = {};
    for (const o of sold) {
      const z = o.zoneName || 'بلا منطقة';
      byZone[z] ??= { orders: 0, revenue: 0 };
      byZone[z].orders += 1; byZone[z].revenue += o.total;
    }
    const customersReport = {
      buyers: buyers.length, newBuyers, returningBuyers: buyers.length - newBuyers,
      previousBuyers: new Set(prevSold.map((o) => o.customerId).filter(Boolean)).size,
      top: [...spend.values()].sort((a, b) => b.spent - a.spent).slice(0, 15),
      byZone,
    };

    // ── القسائم ──
    const coupons = new Map<string, { code: string; uses: number; discount: number; revenue: number }>();
    for (const o of sold) {
      if (!o.couponCode) continue;
      const r = coupons.get(o.couponCode) ?? { code: o.couponCode, uses: 0, discount: 0, revenue: 0 };
      r.uses += 1; r.discount += o.discount; r.revenue += o.total;
      coupons.set(o.couponCode, r);
    }
    const couponsReport = { rows: [...coupons.values()].sort((a, b) => b.uses - a.uses), ordersWithCoupon: pct([...coupons.values()].reduce((a, c) => a + c.uses, 0), sold.length) };

    // ── المخزون (الآن، لا للفترة) ──
    const inventory = {
      products: products.length,
      live: products.filter((p) => p.live).length,
      outOfStock: products.filter((p) => p.live && p.qty <= 0).length,
      low: products.filter((p) => p.live && p.qty > 0 && p.qty <= 3).map((p) => ({ id: p.id, name: p.name, qty: p.qty })).slice(0, 30),
      units: products.reduce((a, p) => a + Math.max(0, p.qty), 0),
      value: products.reduce((a, p) => a + Math.max(0, p.qty) * p.price, 0),
      costValue: products.reduce((a, p) => a + Math.max(0, p.qty) * (p.costPrice ?? 0), 0),
      costCoverage: pct(products.filter((p) => (p.costPrice ?? 0) > 0).length, products.length),
    };

    return hideCost(ctx, {
      range: { from: ymd(from), to: ymd(to), days, previousFrom: ymd(prevFrom) },
      sales, orders: ordersReport, products: productsReport, customers: customersReport, coupons: couponsReport, inventory,
    });
  }
}

@PlanFeature('advancedReports')
@Controller('shop/stores/:storeId')
export class ShopReportsController {
  constructor(private readonly reports: ShopReportsService) {}

  @ShopSection('reports')
  @Get('reports')
  report(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.report(ctx, storeId, from, to);
  }
}
