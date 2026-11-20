import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min, NotEquals } from 'class-validator';
import { randomInt } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly, RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { PlatformContext, TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { grantTemplate } from '../shop/store-templates';
import { STORE_REF } from './dto/shop-billing.dto';
import { PLAN_BY_CODE, InvoiceKind, InvoiceStatus, ShopPlan } from './shop-billing.constants';
import { plansConfig } from './plans';
import { StoreSubscriptionsService } from './store-subscriptions.service';

/**
 * محفظة التاجر لدى RVIOS، والفترة التجريبية، والإحالات.
 *
 * - **المحفظة**: تُشحن بفاتورة «شحن» تؤكّدها الإدارة، ويدفع التاجر منها فواتيره فورًا بلا
 *   إيصال. الرصيد عمود على الحساب، وكل حركة سطر في دفتر لا يُعدَّل (`MerchantWalletTx`).
 *   الخصم ذرّي بشرط الرصيد (`walletBalance >= المبلغ`) — لا رصيد سالبًا ولو تزامن طلبان.
 * - **التجربة**: الباقة المحدّدة في إعداد الباقات أيامًا معدودة، مرة واحدة لكل حساب.
 * - **الإحالة**: رمز لكل حساب؛ من سجّل به ثم دفع أول اشتراك يُكافأ داعيه بنسبة منه في محفظته.
 */
@Injectable()
export class MerchantWalletService {
  private readonly log = new Logger('MerchantWallet');
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly subs: StoreSubscriptionsService,
  ) {}

  /** حركة دائنة أو مدينة — ذرّية، والمدينة لا تتجاوز الرصيد */
  async move(companyId: string, amount: number, kind: string, opts: { note?: string; invoiceId?: string; by?: string } = {}) {
    if (!Number.isFinite(amount) || amount === 0) throw new BadRequestException('مبلغ غير صالح');
    return this.prisma.$transaction(async (tx) => {
      const where: Prisma.OrganizationWhereInput = { id: companyId, ...(amount < 0 ? { walletBalance: { gte: -amount } } : {}) };
      const r = await tx.organization.updateMany({ where, data: { walletBalance: { increment: amount } } });
      if (!r.count) throw new ConflictException({ message: 'رصيد المحفظة لا يكفي — اشحنها أولًا', code: 'WALLET_LOW' });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: companyId }, select: { walletBalance: true } });
      return tx.merchantWalletTx.create({
        data: { companyId, amount, kind, note: opts.note, invoiceId: opts.invoiceId, createdBy: opts.by, balance: org.walletBalance },
      });
    });
  }

  /** رمز الإحالة — يُولَّد عند أول طلب */
  async referralCode(companyId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({ where: { id: companyId }, select: { referralCode: true } });
    if (org?.referralCode) return org.referralCode;
    const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 10; i++) {
      const code = 'RV' + Array.from({ length: 6 }, () => ABC[randomInt(ABC.length)]).join('');
      const r = await this.prisma.organization.updateMany({ where: { id: companyId, referralCode: null }, data: { referralCode: code } }).catch(() => null);
      if (r?.count) return code;
      const again = await this.prisma.organization.findUnique({ where: { id: companyId }, select: { referralCode: true } });
      if (again?.referralCode) return again.referralCode;
    }
    throw new ConflictException('تعذّر توليد رمز إحالة');
  }

  /** يربط حسابًا جديدًا بمن دعاه — رمز مجهول أو دعوة النفس تُتجاهل بصمت */
  async attachReferrer(companyId: string, code?: string | null) {
    const c = (code ?? '').trim().toUpperCase();
    if (!/^RV[A-Z0-9]{6}$/.test(c)) return;
    const ref = await this.prisma.organization.findUnique({ where: { referralCode: c }, select: { id: true } });
    if (!ref || ref.id === companyId) return;
    await this.prisma.organization.updateMany({ where: { id: companyId, referredById: null }, data: { referredById: ref.id } });
  }

  /** مكافأة الداعي عند أول اشتراك مدفوع للمدعوّ — مرة واحدة (المطالبة ذرّية) */
  async rewardReferrer(companyId: string, inv: { id: string; kind: number; amount: Prisma.Decimal | number }) {
    if (inv.kind !== InvoiceKind.Subscription) return;
    const org = await this.prisma.organization.findUnique({ where: { id: companyId }, select: { referredById: true, referralRewardedAt: true, name: true } });
    if (!org?.referredById || org.referralRewardedAt) return;
    const reward = Math.floor((Number(inv.amount) * plansConfig().referralPercent) / 100);
    const claimed = await this.prisma.organization.updateMany({ where: { id: companyId, referralRewardedAt: null }, data: { referralRewardedAt: new Date() } });
    if (!claimed.count || reward <= 0) return;
    await this.move(org.referredById, reward, 'referral', { note: `مكافأة إحالة — ${org.name}`, invoiceId: inv.id })
      .catch((e) => this.log.error(`referral reward failed: ${(e as Error).message}`));
  }

  /** دفع فاتورة من المحفظة: تُسدَّد فورًا وتُفعَّل نهائيًا (لا مراجعة — المال عندنا) */
  async payInvoice(ctx: TenantContext, invoiceId: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const inv = await db.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.deletedAt) throw new NotFoundException('الفاتورة غير موجودة');
    if (inv.kind === InvoiceKind.WalletTopup) throw new BadRequestException('شحن المحفظة لا يُدفع منها');
    if (inv.status !== InvoiceStatus.Unpaid) throw new ConflictException('هذه الفاتورة ليست بانتظار الدفع');
    const amount = Number(inv.amount);
    // الحجز أولًا: فاتورة غير مدفوعة تصير «مدفوعة» مرة واحدة حتى لو ضُغط الزر مرتين
    const lock = await db.platformInvoice.updateMany({
      where: { id: inv.id, status: InvoiceStatus.Unpaid },
      data: { status: InvoiceStatus.Paid, method: 'wallet', paidAt: new Date(), reviewedAt: new Date(), version: { increment: 1 } },
    });
    if (!lock.count) throw new ConflictException('هذه الفاتورة ليست بانتظار الدفع');
    try {
      await this.move(ctx.companyId, -amount, 'pay', { note: `فاتورة ${inv.invoiceNumber}`, invoiceId: inv.id, by: ctx.userId });
    } catch (e) {
      await db.platformInvoice.update({ where: { id: inv.id }, data: { status: InvoiceStatus.Unpaid, method: null, paidAt: null, reviewedAt: null } });
      throw e;
    }
    if (inv.kind === InvoiceKind.Subscription && inv.storeRef && inv.plan) await this.subs.activatePlan(ctx.companyId, inv.storeRef, inv.plan, inv.months ?? 1);
    if (inv.kind === InvoiceKind.ExtraStore) await this.subs.grantSlot(ctx.companyId);
    if (inv.kind === InvoiceKind.Template && inv.storeRef && inv.item) await grantTemplate(db, inv.storeRef, inv.item);
    await this.rewardReferrer(ctx.companyId, inv);
    return db.platformInvoice.findUnique({ where: { id: inv.id } });
  }

  /** الفترة التجريبية المجانية — مرة لكل حساب، لمتجر على المجانية */
  async startTrial(ctx: TenantContext, storeRef: string) {
    const cfg = plansConfig();
    if (!cfg.trialDays) throw new ConflictException({ message: 'لا فترة تجريبية متاحة الآن', code: 'TRIAL_OFF' });
    const store = await this.prisma.forTenant(ctx.companyId).shopStore.findFirst({ where: { id: storeRef }, select: { id: true, name: true } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    const sub = await this.subs.ensure(ctx.companyId, storeRef, store.name);
    if (this.subs.effectivePlan(sub) !== ShopPlan.Basic) throw new ConflictException({ message: 'متجرك على باقة مدفوعة بالفعل', code: 'TRIAL_PAID' });
    const claimed = await this.prisma.organization.updateMany({ where: { id: ctx.companyId, storeTrialUsedAt: null }, data: { storeTrialUsedAt: new Date() } });
    if (!claimed.count) throw new ConflictException({ message: 'استُخدمت الفترة التجريبية لهذا الحساب من قبل', code: 'TRIAL_USED' });
    const plan = PLAN_BY_CODE[cfg.trialPlan] ?? ShopPlan.Pro;
    return this.subs.view(await this.subs.startTrial(ctx.companyId, storeRef, plan, cfg.trialDays));
  }

  async summary(companyId: string) {
    const cfg = plansConfig();
    const code = await this.referralCode(companyId);
    const [org, txs, invited, rewarded, earned] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: companyId }, select: { walletBalance: true, storeTrialUsedAt: true } }),
      this.prisma.merchantWalletTx.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.organization.count({ where: { referredById: companyId, deletedAt: null } }),
      this.prisma.organization.count({ where: { referredById: companyId, referralRewardedAt: { not: null } } }),
      this.prisma.merchantWalletTx.aggregate({ where: { companyId, kind: 'referral' }, _sum: { amount: true } }),
    ]);
    const dash = (process.env.DASHBOARD_URL || process.env.APP_URL || 'https://azm.rvios.com').replace(/\/+$/, '');
    return {
      balance: Number(org?.walletBalance ?? 0),
      currency: cfg.currency,
      txs: txs.map((t) => ({ id: t.id, amount: Number(t.amount), balance: Number(t.balance), kind: t.kind, note: t.note, invoiceId: t.invoiceId, createdAt: t.createdAt })),
      referral: { code, link: `${dash}/register?ref=${code}`, percent: cfg.referralPercent, invited, rewarded, pending: invited - rewarded, earned: Number(earned._sum.amount ?? 0) },
      trial: { days: cfg.trialDays, plan: cfg.trialPlan, planName: cfg.plans[cfg.trialPlan]?.name ?? '', usedAt: org?.storeTrialUsedAt ?? null, available: !!cfg.trialDays && !org?.storeTrialUsedAt },
    };
  }
}

class TrialDto {
  @IsString()
  @Length(1, 64)
  storeRef!: string;
}

class AdjustWalletDto {
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  @Min(-10_000_000)
  @Max(10_000_000)
  amount!: number;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}

@Controller('shop')
export class MerchantWalletController {
  constructor(private readonly wallet: MerchantWalletService) {}

  /** المحفظة والإحالات والتجربة في صفحة واحدة */
  @Get('wallet')
  summary(@Tenant() ctx: TenantContext) {
    return this.wallet.summary(ctx.companyId);
  }

  @RequireRole(UserRole.Admin)
  @Post('invoices/:id/pay-wallet')
  pay(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.payInvoice(ctx, id);
  }

  @RequireRole(UserRole.Admin)
  @Post('billing/trial')
  trial(@Tenant() ctx: TenantContext, @Body() dto: TrialDto) {
    if (!STORE_REF.test(dto.storeRef)) throw new BadRequestException('معرّف متجر غير صالح');
    return this.wallet.startTrial(ctx, dto.storeRef);
  }
}

/** فريق المنصة: رصيد حساب وحركاته، وتعديل يدوي (تعويض أو تصحيح) يُسجَّل باسم من أجراه */
@PlatformOnly()
@Controller('platform/companies')
export class PlatformWalletController {
  constructor(private readonly wallet: MerchantWalletService, private readonly prisma: TenantPrismaService) {}

  @Get(':id/wallet')
  async get(@Platform() _ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id }, select: { id: true } });
    if (!org) throw new NotFoundException('الحساب غير موجود');
    return this.wallet.summary(id);
  }

  @Post(':id/wallet')
  async adjust(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustWalletDto) {
    if (!ctx.userId) throw new ForbiddenException();
    await this.wallet.move(id, dto.amount, 'adjust', { note: dto.note || 'تعديل من فريق المنصة', by: ctx.userId });
    return this.wallet.summary(id);
  }
}

