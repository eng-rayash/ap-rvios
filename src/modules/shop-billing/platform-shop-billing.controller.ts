import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import {
  MarkNotifiedDto,
  UpdatePlatformSettingsDto,
  UpdateStoreSubscriptionDto,
} from './dto/shop-billing.dto';
import { PlatformSettingsService } from './platform-settings.service';
import { MS_DAY, ShopPlan, SubStatus } from './shop-billing.constants';
import { StoreSubscriptionsService } from './store-subscriptions.service';

/**
 * لوحة فريق المنصة لاشتراكات المتاجر وإعداداتها — عبر كل الشركات.
 *
 * تستعمل العميل الأساس عمدًا (لا `forTenant`) كبقية مسارات `platform/*`:
 * حارس `@PlatformOnly()` هو من يحدّد من يصل، وليس التقييد بشركة.
 */
@PlatformOnly()
@Controller('platform')
export class PlatformShopBillingController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly subs: StoreSubscriptionsService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /** شاشة واحدة: من ينتهي هذا الأسبوع؟ ومن في المهلة؟ */
  @Get('store-subscriptions')
  async list(@Platform() _ctx: PlatformContext, @Query('filter') filter?: string) {
    const now = new Date();
    const where: Record<string, unknown> = { deletedAt: null };

    if (filter === 'active') where.status = SubStatus.Active;
    else if (filter === 'grace') where.status = SubStatus.Grace;
    else if (filter === 'expired') where.status = SubStatus.Expired;
    else if (filter === 'paid') where.plan = { not: ShopPlan.Basic };
    else if (filter === 'soon') {
      where.status = SubStatus.Active;
      where.currentPeriodEnd = {
        lte: new Date(now.getTime() + 7 * MS_DAY),
        not: null,
      };
    }

    const rows = await this.prisma.storeSubscription.findMany({
      where,
      orderBy: [{ currentPeriodEnd: { sort: 'asc', nulls: 'last' } }],
      take: 300,
      include: { organization: { select: { id: true, name: true, companyCode: true } } },
    });

    const count = (w: object) =>
      this.prisma.storeSubscription.count({ where: { deletedAt: null, ...w } });
    return {
      subscriptions: rows,
      counts: {
        all: await count({}),
        active: await count({ status: SubStatus.Active }),
        grace: await count({ status: SubStatus.Grace }),
        expired: await count({ status: SubStatus.Expired }),
        paid: await count({ plan: { not: ShopPlan.Basic } }),
      },
    };
  }

  /**
   * تعديل اشتراك يدويًا — يلزم حين يدفع تاجر خارج المسار (تحويل وصل
   * والفاتورة ضاعت) أو تعويضًا عن عطل. التمديد من اليوم لا من تاريخ
   * انتهاءٍ مضى: تمديد اشتراكٍ منتهٍ منذ شهر بثلاثين يومًا كان سيُبقيه
   * منتهيًا.
   */
  @Patch('store-subscriptions/:id')
  async update(
    @Platform() _ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreSubscriptionDto,
  ) {
    const sub = await this.prisma.storeSubscription.findUnique({ where: { id } });
    if (!sub || sub.deletedAt) throw new NotFoundException('الاشتراك غير موجود');

    const data: Record<string, unknown> = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.plan !== undefined) data.plan = dto.plan;
    if (dto.extendDays) {
      const from =
        sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > Date.now()
          ? sub.currentPeriodEnd
          : new Date();
      data.currentPeriodEnd = new Date(from.getTime() + dto.extendDays * MS_DAY);
    }
    if (!Object.keys(data).length) return sub;

    return this.prisma.storeSubscription.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  /** حذف اشتراك متجر حذفته الإدارة — نفس الحذف الناعم الذي يجريه التاجر. */
  @Delete('store-subscriptions/:id')
  async remove(
    @Platform() _ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const sub = await this.prisma.storeSubscription.findUnique({ where: { id } });
    if (!sub || sub.deletedAt) throw new NotFoundException('الاشتراك غير موجود');
    await this.subs.remove(sub.companyId, sub.storeRef);
    return { ok: true };
  }

  /** كنس دوري — تستدعيه منصة المتاجر (أو مهمة مجدولة) ثم ترسل التذكيرات. */
  @Post('store-subscriptions/sweep')
  sweep(@Platform() _ctx: PlatformContext) {
    return this.subs.sweep();
  }

  /** تأكيد إرسال تذكير — بعد نجاح الإرسال فقط. */
  @Post('store-subscriptions/:id/notified')
  notified(
    @Platform() _ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkNotifiedDto,
  ) {
    return this.subs.markNotified(id, dto.stage);
  }

  @Get('settings')
  getSettings(@Platform() _ctx: PlatformContext) {
    return this.settings.snapshot();
  }

  @Patch('settings')
  async patchSettings(
    @Platform() _ctx: PlatformContext,
    @Body() dto: UpdatePlatformSettingsDto,
  ) {
    const applied = await this.settings.update(dto.values);
    return { applied, ...(await this.settings.snapshot()) };
  }
}
