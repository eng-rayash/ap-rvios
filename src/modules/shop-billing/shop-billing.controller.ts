import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { Public, RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import {
  CreateShopInvoiceDto,
  EnsureSubscriptionDto,
  STORE_REF,
  SubmitProofDto,
} from './dto/shop-billing.dto';
import { STORE_TEMPLATES } from '../shop/store-templates';
import { PlatformSettingsService } from './platform-settings.service';
import { ShopInvoicesService } from './shop-invoices.service';
import { StoreSubscriptionsService } from './store-subscriptions.service';

function assertStoreRef(ref: string): string {
  if (!STORE_REF.test(ref)) throw new BadRequestException('معرّف متجر غير صالح');
  return ref;
}

/**
 * مسارات التاجر لفوترة منصة المتاجر.
 *
 * الشركة من الجلسة دائمًا. أمّا `storeRef` فيأتي من العميل — وهذا آمن:
 * أي متجر يُسمّيه التاجر يقع تحت شركته هو، فلا يستطيع لمس اشتراك غيره.
 */
@Controller('shop')
export class ShopBillingController {
  constructor(
    private readonly subs: StoreSubscriptionsService,
    private readonly invoices: ShopInvoicesService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * الأسعار المعلنة فقط — عامة عمدًا لصفحة الباقات التي يراها الزائر.
   * وسائل الدفع (أرقام حسابات) تبقى خلف الجلسة في `billing/pricing`.
   */
  @Public()
  @Get('public/pricing')
  async publicPricing() {
    const prices = await this.settings.planPrices();
    const yearlyMonthsFree = await this.settings.yearlyMonthsFree();
    const year = (m: number | null) => (m ? m * (12 - yearlyMonthsFree) : null);
    const templates = await this.settings.templatePrices();
    return {
      prices,
      addons: await this.settings.addonPrices(),
      yearlyMonthsFree,
      currency: await this.settings.currency(),
      // بأسماء منصة المتاجر الجديدة: احترافي = بلس، أعمال = برو
      plans: {
        free: { month: 0, year: 0 },
        pro: { month: prices.plus, year: year(prices.plus) },
        biz: { month: prices.pro, year: year(prices.pro) },
      },
      templates: Object.entries(STORE_TEMPLATES).map(([id, t]) => ({ id, tier: t.tier, price: t.tier === 'free' ? 0 : templates[id] })),
    };
  }

  /** الأسعار ووسائل الدفع — لعرض صفحة الترقية. */
  @Get('billing/pricing')
  async pricing(@Tenant() _ctx: TenantContext) {
    // المعلن نفسه + وسائل الدفع (أرقام الحسابات) لمن دخل فقط
    return { ...(await this.publicPricing()), methods: await this.settings.paymentMethods() };
  }

  /** خانات المتاجر التي يملكها الحساب. */
  @Get('billing/slots')
  async slots(@Tenant() ctx: TenantContext) {
    const sub = await this.subs.slotsOf(ctx.companyId);
    return sub;
  }

  /** يضمن وجود اشتراك للمتجر ويعيد حالته — تستدعيه المنصة عند إنشاء متجر. */
  @Put('subscriptions/:storeRef')
  async ensure(
    @Tenant() ctx: TenantContext,
    @Param('storeRef') storeRef: string,
    @Body() dto: EnsureSubscriptionDto,
  ) {
    const sub = await this.subs.ensure(
      ctx.companyId,
      assertStoreRef(storeRef),
      dto.storeName,
    );
    return this.subs.view(sub);
  }

  /**
   * متجر إضافي يرث باقة الحساب: التاجر دفع برو ثم دفع خانة بسعر مخفّض —
   * لو بدأ متجره الثاني بحدود المجانية لكان اشترى خانة بلا قيمة. تنسخ
   * الباقة والحالة والفترة من اشتراك آخر **في شركته هو**.
   */
  @RequireRole(UserRole.Admin)
  @Post('subscriptions/:storeRef/inherit/:fromRef')
  async inherit(
    @Tenant() ctx: TenantContext,
    @Param('storeRef') storeRef: string,
    @Param('fromRef') fromRef: string,
  ) {
    const sub = await this.subs.inherit(
      ctx.companyId,
      assertStoreRef(storeRef),
      assertStoreRef(fromRef),
    );
    return this.subs.view(sub);
  }

  /** حذف اشتراك متجر حُذف — لا يبقى يتيمًا في العدّ ولا في لوحة الإدارة. */
  @RequireRole(UserRole.Admin)
  @Delete('subscriptions/:storeRef')
  async removeSubscription(
    @Tenant() ctx: TenantContext,
    @Param('storeRef') storeRef: string,
  ) {
    await this.subs.remove(ctx.companyId, assertStoreRef(storeRef));
    return { ok: true };
  }

  @Get('subscriptions/:storeRef')
  async subscription(
    @Tenant() ctx: TenantContext,
    @Param('storeRef') storeRef: string,
  ) {
    const sub = await this.subs.ensure(ctx.companyId, assertStoreRef(storeRef));
    return this.subs.view(sub);
  }

  @Get('invoices')
  invoicesList(
    @Tenant() ctx: TenantContext,
    @Query('storeRef') storeRef?: string,
  ) {
    return this.invoices.list(ctx, storeRef ? assertStoreRef(storeRef) : undefined);
  }

  @RequireRole(UserRole.Admin)
  @Post('invoices')
  createInvoice(@Tenant() ctx: TenantContext, @Body() dto: CreateShopInvoiceDto) {
    return this.invoices.create(ctx, {
      storeRef: assertStoreRef(dto.storeRef),
      kind: dto.kind,
      plan: dto.plan,
      months: dto.months,
      template: dto.template,
    });
  }

  @RequireRole(UserRole.Admin)
  @Post('invoices/:id/proof')
  submitProof(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitProofDto,
  ) {
    return this.invoices.submitProof(ctx, id, dto);
  }
}
