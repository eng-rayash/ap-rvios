import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { VersionConflictError } from '../meetings/meetings.service';
import { InvoiceItemInput } from './dto/invoice-item.dto';

type TenantDb = ReturnType<TenantPrismaService['forTenant']>;

/**
 * AZM — الفواتير
 *
 * يتبع نموذج `MeetingsService`، بفارق واحد يستحقّ الشرح: المبالغ
 * (`subtotal`, `taxAmount`, `total`, `remainingAmount`) تُحسب هنا لا
 * تُقبل من العميل — نفس مبدأ حقن `companyId`، قيمة يقرّرها الخادم لأن
 * تركها للعميل يفتح على فاتورة أرقامها لا تتّسق مع بنودها.
 */
@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async findAll(ctx: TenantContext, params?: { since?: Date }) {
    const db = this.prisma.forTenant(ctx.companyId);

    return db.invoice.findMany({
      where: {
        deletedAt: null,
        ...(params?.since ? { updatedAt: { gt: params.since } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const invoice = await db.invoice.findUnique({ where: { id } });

    if (!invoice || invoice.deletedAt) {
      throw new NotFoundException('الفاتورة غير موجودة');
    }
    return invoice;
  }

  async create(ctx: TenantContext, input: CreateInvoiceInput) {
    const db = this.prisma.forTenant(ctx.companyId);
    const totals = computeTotals(input.items, input.discountAmount ?? 0, input.taxPercent ?? 0);
    const invoiceNumber = await this.generateInvoiceNumber(db);

    return db.invoice.create({
      data: tenantCreate<Prisma.InvoiceUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        invoiceNumber,
        clientId: input.clientId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        items: input.items as unknown as Prisma.InputJsonValue,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxPercent: totals.taxPercent,
        taxAmount: totals.taxAmount,
        total: totals.total,
        paidAmount: 0,
        remainingAmount: totals.total,
        currency: input.currency ?? 'SAR',
        status: input.status ?? 0,
        createdBy: ctx.userId,
      }),
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateInvoiceInput,
    expectedVersion?: number,
  ) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }

    // البنود أو نسبة الضريبة أو مبلغ الخصم قد تتغيّر معًا أو منفردة —
    // إعادة الحساب من القيم الحالية حين لا يرسل الطلب بديلًا، فلا
    // يفقد المبلغ اتّساقه بتعديل جزئي.
    const items =
      (input.items as InvoiceItemInput[] | undefined) ??
      (current.items as unknown as InvoiceItemInput[]);
    const discountAmount =
      input.discountAmount ?? Number(current.discountAmount);
    const taxPercent = input.taxPercent ?? Number(current.taxPercent);
    const totals = computeTotals(items, discountAmount, taxPercent);

    const paidAmount = input.paidAmount ?? Number(current.paidAmount);
    const remainingAmount = round2(totals.total - paidAmount);

    return db.invoice.update({
      where: { id },
      data: {
        clientId: input.clientId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency: input.currency,
        status: input.status,
        items: items as unknown as Prisma.InputJsonValue,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxPercent: totals.taxPercent,
        taxAmount: totals.taxAmount,
        total: totals.total,
        paidAmount,
        remainingAmount,
        version: { increment: 1 },
      },
    });
  }

  /** حذف ناعم. يتطلّب مديرًا ماليًا فأعلى — الفواتير سجلّ مالي. */
  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);

    return db.invoice.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }

  /**
   * رقم فاتورة بصيغة `INV-000001`، فريد داخل الشركة.
   *
   * يبدأ من عدد الفواتير الحالي + ١، ويُعيد المحاولة برقم أعلى عند
   * تصادم (طلبان متزامنان) — نفس نمط `generateCompanyCode`.
   */
  private async generateInvoiceNumber(db: TenantDb): Promise<string> {
    const count = await db.invoice.count();

    for (let attempt = 0; attempt < 10; attempt++) {
      const number = `INV-${String(count + 1 + attempt).padStart(6, '0')}`;
      const clash = await db.invoice.findFirst({
        where: { invoiceNumber: number },
        select: { id: true },
      });
      if (!clash) return number;
    }
    throw new ConflictException('تعذّر توليد رقم فاتورة فريد');
  }
}

export interface CreateInvoiceInput {
  syncId?: string;
  clientId?: string;
  issueDate: string;
  dueDate?: string;
  items: InvoiceItemInput[];
  discountAmount?: number;
  taxPercent?: number;
  currency?: string;
  status?: number;
}

export type UpdateInvoiceInput = Partial<
  Omit<CreateInvoiceInput, 'syncId'>
> & { paidAmount?: number };

/** يجمع بنود الفاتورة إلى المبالغ الأربعة المشتقّة منها. */
function computeTotals(
  items: InvoiceItemInput[],
  discountAmount: number,
  taxPercent: number,
) {
  const subtotal = round2(
    items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );
  const taxable = Math.max(0, subtotal - discountAmount);
  const taxAmount = round2((taxable * taxPercent) / 100);
  const total = round2(taxable + taxAmount);

  return { subtotal, discountAmount: round2(discountAmount), taxPercent, taxAmount, total };
}

/** تقريب لخانتين عشريتين — لا فلس يضيع في جمع متكرّر. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
