import { Controller, Get } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import { StoreStatus } from '../shop/shop.constants';

const MONTHS = 6;

/**
 * نظرة عامة على المنصة كلها — أرقام حقيقية عبر الشركات لفريق RVIOS.
 * يستعمل العميل الأساس عمدًا كبقية مسارات `platform/*`.
 */
@PlatformOnly()
@Controller('platform/overview')
export class PlatformOverviewController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  async overview(@Platform() _ctx: PlatformContext) {
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1), 1));
    const soon = new Date(now.getTime() + 7 * 86_400_000);

    const [
      companies,
      users,
      stores,
      suspended,
      products,
      orders,
      subsPaid,
      subsGrace,
      subsSoon,
      pendingInvoices,
      paidRecent,
      newCompanies,
      newStores,
    ] = await Promise.all([
      this.prisma.organization.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.shopStore.count(),
      this.prisma.shopStore.count({ where: { status: StoreStatus.Suspended } }),
      this.prisma.shopProduct.count(),
      this.prisma.shopOrder.count(),
      this.prisma.storeSubscription.count({ where: { deletedAt: null, plan: { not: 0 }, status: 0 } }),
      this.prisma.storeSubscription.count({ where: { deletedAt: null, status: 1 } }),
      this.prisma.storeSubscription.count({
        where: { deletedAt: null, status: 0, plan: { not: 0 }, currentPeriodEnd: { gte: now, lte: soon } },
      }),
      this.prisma.platformInvoice.count({ where: { deletedAt: null, status: { in: [0, 1] } } }),
      this.prisma.platformInvoice.findMany({
        where: { deletedAt: null, status: 2, paidAt: { gte: since } },
        select: { amount: true, paidAt: true },
      }),
      this.prisma.organization.findMany({
        where: { deletedAt: null, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.prisma.shopStore.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    ]);

    const buckets = Array.from({ length: MONTHS }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1 - i), 1));
      return { key: `${d.getUTCFullYear()}-${d.getUTCMonth()}`, month: d.toISOString().slice(0, 7), revenue: 0, companies: 0, stores: 0 };
    });
    const at = (d: Date) => buckets.find((b) => b.key === `${d.getUTCFullYear()}-${d.getUTCMonth()}`);
    for (const p of paidRecent) if (p.paidAt) { const b = at(p.paidAt); if (b) b.revenue += Number(p.amount); }
    for (const c of newCompanies) { const b = at(c.createdAt); if (b) b.companies += 1; }
    for (const s of newStores) { const b = at(s.createdAt); if (b) b.stores += 1; }

    const byPlan = await this.prisma.storeSubscription.groupBy({
      by: ['plan'],
      where: { deletedAt: null },
      _count: { _all: true },
    });

    return {
      totals: {
        companies,
        users,
        stores,
        suspendedStores: suspended,
        products,
        orders,
        paidSubscriptions: subsPaid,
        graceSubscriptions: subsGrace,
        expiringSoon: subsSoon,
        pendingInvoices,
      },
      plans: byPlan.map((p) => ({ plan: p.plan, count: p._count._all })),
      series: buckets.map(({ month, revenue, companies: c, stores: s }) => ({ month, revenue, companies: c, stores: s })),
    };
  }
}
