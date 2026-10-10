import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { PlatformSettingsService } from './platform-settings.service';
import {
  DUE_DAYS,
  InvoiceKind,
  InvoiceStatus,
  MAX_STORE_SLOTS,
  MS_DAY,
  PLAN_BY_CODE,
  ShopPlan,
} from './shop-billing.constants';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { STORE_TEMPLATES, grantTemplate, isTemplate, templateCost } from '../shop/store-templates';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * فواتير التاجر إلى RVIOS — منقولة من `createInvoice` و`submitProof` في
 * منصة المتاجر.
 *
 * النطاق: التاجر ← RVIOS فقط (اشتراكات وخدمات). العميل ← التاجر يبقى
 * خارجه تمامًا، فتظل المنصة بائع خدمة برمجية لا مجمّع مدفوعات.
 *
 * كل قراءة وكتابة هنا عبر `forTenant`، و`platformInvoice` ضمن
 * `TENANT_MODELS`: التاجر لا يرى فاتورة غيره حتى لو خمّن معرّفها.
 */
@Injectable()
export class ShopInvoicesService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly subs: StoreSubscriptionsService,
  ) {}

  async list(ctx: TenantContext, storeRef?: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.platformInvoice.findMany({
      where: { deletedAt: null, ...(storeRef ? { storeRef } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async create(
    ctx: TenantContext,
    input: {
      storeRef: string;
      kind: InvoiceKind;
      plan?: string;
      months?: number;
      template?: string;
    },
  ) {
    const db = this.prisma.forTenant(ctx.companyId);
    const { storeRef, kind } = input;
    const months = input.months ?? 1;

    let amount: number;
    let plan: ShopPlan | null = null;
    let item: string | null = null;

    if (kind === InvoiceKind.Template) {
      // القالب يُشترى لمتجر قائم في هذه الشركة — الملكية تُسجَّل عليه
      const store = await db.shopStore.findFirst({ where: { id: storeRef }, select: { id: true, ownedTemplates: true } });
      if (!store) throw new NotFoundException('المتجر غير موجود');
      const id = input.template ?? '';
      if (!isTemplate(id)) throw new BadRequestException('قالب غير معروف');
      if (store.ownedTemplates.includes(id)) throw new ConflictException({ message: 'هذا القالب مملوك لمتجرك بالفعل', code: 'TEMPLATE_OWNED' });
      const sub = await this.subs.ensure(ctx.companyId, storeRef);
      const base = (await this.settings.templatePrices())[id] ?? STORE_TEMPLATES[id].price;
      const cost = templateCost(id, this.subs.effectivePlan(sub), base);
      if (cost === null) {
        throw new ConflictException({ message: 'القوالب المدفوعة تحتاج باقة مدفوعة — رقِّ باقتك أولاً', code: 'PLAN_REQUIRED' });
      }
      if (cost === 0) {
        throw new ConflictException({ message: 'هذا القالب متاح لباقتك بلا شراء — اختره من إعدادات المتجر', code: 'TEMPLATE_FREE' });
      }
      amount = cost;
      item = id;
    } else if (kind === InvoiceKind.Subscription) {
      plan = PLAN_BY_CODE[input.plan ?? ''] ?? null;
      if (plan === null || plan === ShopPlan.Basic) {
        throw new BadRequestException('باقة غير صالحة للفوترة');
      }
      const prices = await this.settings.planPrices();
      const monthly = plan === ShopPlan.Plus ? prices.plus : prices.pro;
      if (!monthly) {
        throw new ConflictException({
          message: 'سعر هذه الباقة لم يُعلن بعد — تواصل معنا لإتمام الترقية',
          code: 'PRICE_UNSET',
        });
      }
      const free = months >= 12 ? await this.settings.yearlyMonthsFree() : 0;
      amount = monthly * (months - free);
    } else {
      if (kind === InvoiceKind.ExtraStore) {
        // المتجر الإضافي حكر على برو — الباقة تفتح الإمكانية ولا تهدي متجرًا
        const sub = await this.subs.ensure(ctx.companyId, storeRef);
        if (this.subs.effectivePlan(sub) !== ShopPlan.Pro) {
          throw new ConflictException({
            message: 'المتاجر الإضافية متاحة في باقة برو — رقِّ باقتك أولاً',
            code: 'PRO_REQUIRED',
          });
        }
        const org = await this.prisma.organization.findUnique({
          where: { id: ctx.companyId },
          select: { storeSlots: true },
        });
        if ((org?.storeSlots ?? 1) >= MAX_STORE_SLOTS) {
          throw new ConflictException({
            message: `الحد الأقصى ${MAX_STORE_SLOTS} متاجر لكل حساب`,
            code: 'SLOT_MAX',
          });
        }
      }
      const addons = await this.settings.addonPrices();
      const key = {
        [InvoiceKind.StoreBuild]: 'store_build',
        [InvoiceKind.Domain]: 'domain',
        [InvoiceKind.ExtraStore]: 'extra_store',
      }[kind as 1 | 2 | 3] as 'store_build' | 'domain' | 'extra_store';
      const price = addons[key];
      if (!price) {
        throw new ConflictException({
          message: 'سعر هذه الخدمة لم يُعلن بعد — تواصل معنا',
          code: 'PRICE_UNSET',
        });
      }
      amount = price;
    }

    /**
     * فاتورة مفتوحة من النوع نفسه؟ ثلاث حالات:
     *  ١) مطابقة تمامًا        → أعدها (التاجر ضغط الزر مرتين)
     *  ٢) غير مدفوعة ومختلفة   → ألغِ القديمة وأصدر الجديدة
     *  ٣) رُفع إيصالها         → ارفض بوضوح
     */
    const open = await db.platformInvoice.findFirst({
      where: {
        storeRef,
        kind,
        // فاتورة قالب لا تُلغي فاتورة قالب آخر — لكلٍّ فاتورته
        ...(item ? { item } : {}),
        status: { in: [InvoiceStatus.Unpaid, InvoiceStatus.UnderReview] },
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (open) {
      const same = (open.plan ?? null) === plan && (open.months ?? 1) === months;
      if (same) return open;

      if (open.status === InvoiceStatus.UnderReview) {
        throw new ConflictException({
          message: `لديك فاتورة ${open.invoiceNumber} قيد المراجعة. انتظر تأكيدها قبل طلب تغيير آخر.`,
          code: 'INVOICE_PENDING',
        });
      }
      await db.platformInvoice.update({
        where: { id: open.id },
        data: {
          status: InvoiceStatus.Rejected,
          voidReason: 'استُبدلت بطلب أحدث',
          version: { increment: 1 },
        },
      });
    }

    const today = new Date();
    const end = new Date(today);
    if (kind === InvoiceKind.Subscription) end.setMonth(end.getMonth() + months);

    // المرجع مفتاح تشغيلي عالمي: يكتبه التاجر في ملاحظات التحويل، وتطابقه
    // الإدارة بالحوالة الواصلة من **أي** تاجر. لو تكرّر رقم بين شركتين
    // صارت مطابقة الحوالات مستحيلة — فالتفرّد هنا عبر كل الشركات لا داخل
    // شركة واحدة كالفواتير العادية (`PINV-`). القيد الفريد على
    // [companyId, invoiceNumber] يبقى حكمًا أخيرًا عند سباق متزامن.
    for (let attempt = 0; attempt < 20; attempt++) {
      const invoiceNumber = `RV-INV-${randomInt(100000, 1000000)}`;
      const clash = await this.prisma.platformInvoice.findFirst({
        where: { invoiceNumber },
        select: { id: true },
      });
      if (clash) continue;
      try {
        return await db.platformInvoice.create({
          data: tenantCreate<Prisma.PlatformInvoiceUncheckedCreateInput>({
            syncId: randomUUID(),
            invoiceNumber,
            amount,
            currency: await this.settings.currency(),
            periodStart: ymd(today),
            periodEnd: ymd(end),
            status: InvoiceStatus.Unpaid,
            kind,
            plan,
            item,
            months: kind === InvoiceKind.Subscription ? months : null,
            storeRef,
            dueAt: new Date(today.getTime() + DUE_DAYS * MS_DAY),
          }),
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new ConflictException('تعذّر توليد رقم فاتورة فريد');
  }

  /**
   * رفع إيصال التحويل ← مراجعة + **تفعيل فوري** (§٥.٣).
   *
   * قرار تجربة مستخدم مقصود: التاجر دفع فعلًا، وإبقاؤه منتظرًا يومًا
   * كاملًا تجربة سيئة. مخاطرة إيصال مزوّر واحد أرخص بكثير من إحباط عشرة
   * تجار دافعين — والمراجعة اللاحقة تلغي التفعيل.
   */
  async submitProof(
    ctx: TenantContext,
    invoiceId: string,
    input: { method?: string; proofKey: string },
  ) {
    const db = this.prisma.forTenant(ctx.companyId);
    const inv = await db.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.deletedAt) throw new NotFoundException('الفاتورة غير موجودة');
    if (inv.status === InvoiceStatus.Paid) {
      throw new ConflictException('هذه الفاتورة مدفوعة بالفعل');
    }
    if (inv.status === InvoiceStatus.Rejected) {
      throw new ConflictException('هذه الفاتورة ملغاة');
    }
    if (!input.proofKey) throw new BadRequestException('أرفق صورة الإيصال');

    const updated = await db.platformInvoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.UnderReview,
        method: input.method ?? '',
        proofKey: input.proofKey,
        version: { increment: 1 },
      },
    });

    // التفعيل فوري قبل المراجعة — للاشتراك وللخانة معًا
    if (inv.kind === InvoiceKind.Subscription && inv.storeRef && inv.plan) {
      await this.subs.activatePlan(
        ctx.companyId,
        inv.storeRef,
        inv.plan,
        inv.months ?? 1,
      );
    }
    if (inv.kind === InvoiceKind.ExtraStore) {
      await this.subs.grantSlot(ctx.companyId);
    }
    if (inv.kind === InvoiceKind.Template && inv.storeRef && inv.item) {
      await grantTemplate(db, inv.storeRef, inv.item);
    }
    return updated;
  }
}
