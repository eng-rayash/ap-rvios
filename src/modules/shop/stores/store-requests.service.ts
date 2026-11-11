import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { PlatformContext, TenantContext } from '../../../common/tenant/tenant-context';
import { PlatformInvoicesService } from '../../platform-admin/platform-invoices.service';
import { InvoiceKind, InvoiceStatus } from '../../shop-billing/shop-billing.constants';
import { ShopInvoicesService } from '../../shop-billing/shop-invoices.service';
import { StorefrontCache } from '../public/storefront-cache.service';
import { StoreEmails } from '../../notify/store-emails.service';
import { StoreStatus } from '../shop.constants';
import { CreateStoreDto } from './stores.dto';
import { StoresService } from './stores.service';

const OPEN = [InvoiceStatus.Unpaid, InvoiceStatus.UnderReview];

/**
 * طلب متجر بباقة مدفوعة: يُحجز المتجر بحالة «بانتظار التفعيل» (لا يظهر للزوّار) ومعه فواتير
 * الباقة والقالب، ويتواصل التاجر مع الفريق للدفع. الفريق يفعّله من لوحة المنصة — فتُسدَّد الفواتير
 * وتعمل الباقة والقالب — أو يرفضه فيُحذف ويتحرر رابطه.
 */
import { PlatformAlerts } from '../../notify/platform-alerts.service';
@Injectable()
export class StoreRequestsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly stores: StoresService,
    private readonly invoices: ShopInvoicesService,
    private readonly platformInvoices: PlatformInvoicesService,
    private readonly cache: StorefrontCache,
    private readonly emails: StoreEmails,
    private readonly alerts: PlatformAlerts,
  ) {}

  async create(ctx: TenantContext, dto: CreateStoreDto) {
    const plan = dto.plan!;
    const months = dto.months === 12 ? 12 : 1;
    const { store } = await this.stores.create(ctx, dto, { pending: true });
    try {
      await this.invoices.create(ctx, { storeRef: store.id, kind: InvoiceKind.Subscription, plan, months });
      if (dto.template && dto.template !== 'essential') {
        try {
          await this.invoices.create(ctx, { storeRef: store.id, kind: InvoiceKind.Template, template: dto.template });
        } catch (e) {
          // مشمول في الباقة: يعمل وحده حين تتفعّل — المتجر حفظ القالب المطلوب
          const code = e instanceof ConflictException ? (e.getResponse() as { code?: string }).code : undefined;
          if (code !== 'TEMPLATE_FREE') throw e;
        }
      }
    } catch (e) {
      // طلب بلا فاتورة لا يراه الفريق كاملًا: لا يبقى متجر محجوز بلا سبيل لتفعيله
      await this.stores.platformDelete(store.id);
      throw e;
    }
    const open = await this.prisma.platformInvoice.findMany({ where: { storeRef: store.id, status: { in: OPEN }, deletedAt: null }, select: { amount: true, currency: true } });
    const due = open.reduce((a, i) => a + Number(i.amount), 0);
    void this.emails.storeRequested({ ...store, companyId: ctx.companyId }, due, open[0]?.currency ?? 'USD');
    void this.alerts.raise({
      kind: 'store_request',
      title: `طلب متجر جديد — ${store.name}`,
      body: `المتجر: ${store.name} (${store.slug})\nالباقة: ${plan} · ${months === 12 ? 'سنوي' : 'شهري'}\nالمستحق: ${due} ${open[0]?.currency ?? 'USD'}`,
      link: '/platform/requests',
      data: { storeId: store.id },
    });
    return this.stores.get(ctx, store.id);
  }

  async list() {
    const stores = await this.prisma.shopStore.findMany({
      where: { status: StoreStatus.Pending },
      orderBy: { createdAt: 'asc' },
      include: {
        organization: {
          select: {
            id: true, name: true,
            memberships: { where: { role: 0, deletedAt: null }, take: 1, select: { user: { select: { email: true, displayName: true } } } },
          },
        },
      },
    });
    const invoices = await this.prisma.platformInvoice.findMany({
      where: { storeRef: { in: stores.map((s) => s.id) }, status: { in: OPEN }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, storeRef: true, invoiceNumber: true, kind: true, plan: true, months: true, item: true, amount: true, currency: true, status: true },
    });
    return stores.map((s) => {
      const own = invoices.filter((i) => i.storeRef === s.id);
      return {
        id: s.id, name: s.name, slug: s.slug, whatsapp: s.whatsapp, country: s.country, template: s.template, createdAt: s.createdAt,
        company: { id: s.organization.id, name: s.organization.name },
        owner: s.organization.memberships[0]?.user ?? null,
        invoices: own,
        total: own.reduce((sum, i) => sum + Number(i.amount), 0),
      };
    });
  }

  private async pending(storeId: string) {
    const store = await this.prisma.shopStore.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    if (store.status !== StoreStatus.Pending) throw new BadRequestException('هذا المتجر ليس طلبًا بانتظار التفعيل');
    const invoices = await this.prisma.platformInvoice.findMany({ where: { storeRef: storeId, status: { in: OPEN }, deletedAt: null } });
    return { store, invoices };
  }

  /** الدفع استُلم: الفواتير تُسدَّد (فتعمل الباقة والقالب) ويظهر المتجر للزوّار */
  async activate(storeId: string, ctx: PlatformContext, paymentReference?: string) {
    const { store, invoices } = await this.pending(storeId);
    // الباقة أولًا: سعر القالب ومشموليته يتبعانها
    const ordered = [...invoices].sort((a, b) => (a.kind === InvoiceKind.Subscription ? -1 : b.kind === InvoiceKind.Subscription ? 1 : 0));
    for (const inv of ordered) await this.platformInvoices.review(inv.id, ctx, { decision: 'paid', paymentReference });
    await this.prisma.shopStore.update({ where: { id: storeId }, data: { status: StoreStatus.Active } });
    this.cache.purge(store.slug);
    const base = (process.env.STOREFRONT_URL || 'https://store.rvios.com').replace(/\/+$/, '');
    void this.emails.storeActivated(store, `${base}/s/${store.slug}`);
    return { ok: true, slug: store.slug };
  }

  /** الطلب أُلغي: الفواتير تُرفض للسجل، والمتجر يُحذف فيتحرر رابطه */
  async reject(storeId: string, ctx: PlatformContext, reason?: string) {
    const { invoices } = await this.pending(storeId);
    for (const inv of invoices) await this.platformInvoices.review(inv.id, ctx, { decision: 'rejected', reason: reason ?? 'أُلغي طلب المتجر' });
    await this.stores.platformDelete(storeId);
    return { ok: true };
  }
}
