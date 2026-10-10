import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { PlatformContext } from '../../common/tenant/tenant-context';
import {
  InvoiceKind,
  InvoiceStatus,
} from '../shop-billing/shop-billing.constants';
import { StoreSubscriptionsService } from '../shop-billing/store-subscriptions.service';
import { grantTemplate, revokeTemplate } from '../shop/store-templates';

/**
 * AZM — فواتير الاشتراك، عبر كل المستأجرين
 *
 * نفس استثناء `OrganizationsService` من `forTenant()` — انظر توثيقها.
 * `PlatformInvoice` عمدًا خارج `TENANT_MODELS`: فريق المنصة يستعرض
 * فواتير كل الشركات معًا، لا فاتورة شركة واحدة.
 */
@Injectable()
export class PlatformInvoicesService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly subs: StoreSubscriptionsService,
  ) {}

  async findAll(status?: number) {
    return this.prisma.platformInvoice.findMany({
      where: {
        deletedAt: null,
        ...(status !== undefined ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { organization: { select: { id: true, name: true, companyCode: true } } },
    });
  }

  async findOne(id: string) {
    const invoice = await this.prisma.platformInvoice.findUnique({
      where: { id },
      include: { organization: { select: { id: true, name: true, companyCode: true } } },
    });
    if (!invoice || invoice.deletedAt) {
      throw new NotFoundException('الفاتورة غير موجودة');
    }
    return invoice;
  }

  async create(input: {
    companyId: string;
    amount: number;
    currency?: string;
    periodStart: string;
    periodEnd: string;
  }) {
    const org = await this.prisma.organization.findUnique({
      where: { id: input.companyId },
      select: { id: true, deletedAt: true },
    });
    if (!org || org.deletedAt) {
      throw new NotFoundException('الشركة غير موجودة');
    }

    const invoiceNumber = await this.generateInvoiceNumber(input.companyId);

    return this.prisma.platformInvoice.create({
      data: {
        syncId: randomUUID(),
        companyId: input.companyId,
        invoiceNumber,
        amount: input.amount,
        currency: input.currency ?? 'SAR',
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: 0,
      },
    });
  }

  /**
   * تسجيل قرار المراجعة — دفع أو رفض.
   *
   * `reviewedBy` من [PlatformContext] لا من جسم الطلب: من راجع الفاتورة
   * حقيقة يقرّرها الخادم من الجلسة، لا ما يزعمه الطالب.
   */
  async review(
    id: string,
    ctx: PlatformContext,
    input: {
      decision: 'paid' | 'rejected';
      paymentReference?: string;
      reason?: string;
    },
  ) {
    const inv = await this.findOne(id);
    const paid = input.decision === 'paid';

    const updated = await this.prisma.platformInvoice.update({
      where: { id },
      data: {
        status: paid ? InvoiceStatus.Paid : InvoiceStatus.Rejected,
        paymentReference: input.paymentReference,
        voidReason: paid ? undefined : input.reason ?? '',
        paidAt: paid ? new Date() : undefined,
        reviewedBy: ctx.userId,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
    });

    // فواتير منصة المتاجر: التفعيل قد يكون تمّ عند رفع الإيصال؛ نضمنه
    // للفواتير المؤكَّدة يدويًا، ونسحبه إن رُفض إيصال فُعِّل مسبقًا.
    const wasUnderReview = inv.status === InvoiceStatus.UnderReview;
    if (paid && !wasUnderReview) {
      if (inv.kind === InvoiceKind.Subscription && inv.storeRef && inv.plan) {
        await this.subs.activatePlan(
          inv.companyId,
          inv.storeRef,
          inv.plan,
          inv.months ?? 1,
        );
      }
      if (inv.kind === InvoiceKind.ExtraStore) {
        await this.subs.grantSlot(inv.companyId);
      }
      if (inv.kind === InvoiceKind.Template && inv.storeRef && inv.item) {
        await grantTemplate(this.prisma.forTenant(inv.companyId), inv.storeRef, inv.item);
      }
    }
    if (!paid && wasUnderReview) {
      if (inv.kind === InvoiceKind.Subscription && inv.storeRef) {
        await this.subs.revokePlan(inv.companyId, inv.storeRef);
      }
      if (inv.kind === InvoiceKind.ExtraStore) {
        await this.subs.revokeSlot(inv.companyId);
      }
      if (inv.kind === InvoiceKind.Template && inv.storeRef && inv.item) {
        await revokeTemplate(this.prisma.forTenant(inv.companyId), inv.storeRef, inv.item);
      }
    }
    return updated;
  }

  /** رقم فاتورة بصيغة `PINV-000001`، فريد داخل الشركة — نفس نمط الفواتير العادية. */
  private async generateInvoiceNumber(companyId: string): Promise<string> {
    const count = await this.prisma.platformInvoice.count({ where: { companyId } });

    for (let attempt = 0; attempt < 10; attempt++) {
      const number = `PINV-${String(count + 1 + attempt).padStart(6, '0')}`;
      const clash = await this.prisma.platformInvoice.findFirst({
        where: { companyId, invoiceNumber: number },
        select: { id: true },
      });
      if (!clash) return number;
    }
    throw new ConflictException('تعذّر توليد رقم فاتورة فريد');
  }
}
