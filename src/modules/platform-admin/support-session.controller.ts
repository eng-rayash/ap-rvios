import { Controller, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import { SITE_WORKSPACE_SLUG } from '../cms/site-organization.constant';

/** مدة جلسة الدعم: تكفي لإنجاز عمل، وتسقط وحدها فلا تبقى بابًا مفتوحًا. */
export const SUPPORT_SESSION = '2h';

/**
 * «أدِر هذا المتجر» — جلسة دعم لفريق المنصة داخل لوحة التاجر نفسها.
 *
 * بدل نسخة ثانية من كل شاشة (القالب، الباقة، الإعدادات، الشكل، المنتجات،
 * الطلبات…) يدخل الموظف لوحة الشركة كما يراها صاحبها، فيعمل كل شيء بالأدوات
 * ذاتها. الرمز يحمل `support: true`، والحارس يقبله بلا عضوية لموظف منصة فعّال
 * فقط، بدور «مدير عام» لا «مالك» (لا نقل ملكية ولا حذف للشركة). كل جلسة تُسجَّل
 * في سجل نشاط الشركة باسم الموظف، فيرى صاحبها من دخل ومتى.
 */
@PlatformOnly()
@Controller('platform')
export class SupportSessionController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {}

  @Post('organizations/:id/support-session')
  forCompany(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.open(ctx, id, null);
  }

  /** إدارة الموقع الرئيسي والمدونة: جلسة دعم في شركة الموقع المحجوزة */
  @Post('site/support-session')
  async forSite(@Platform() ctx: PlatformContext) {
    const site = await this.prisma.organization.findFirst({ where: { workspaceSlug: SITE_WORKSPACE_SLUG }, select: { id: true } });
    if (!site) throw new NotFoundException('شركة الموقع غير مهيّأة — شغّل seed الموقع أولًا');
    return this.open(ctx, site.id, null);
  }

  @Post('shop-stores/:id/support-session')
  async forStore(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string) {
    const store = await this.prisma.shopStore.findUnique({ where: { id }, select: { id: true, companyId: true, name: true } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    return this.open(ctx, store.companyId, store);
  }

  private async open(ctx: PlatformContext, companyId: string, store: { id: string; name: string } | null) {
    const company = await this.prisma.organization.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, companyCode: true, workspaceSlug: true },
    });
    if (!company) throw new NotFoundException('الشركة غير موجودة');
    const staff = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { displayName: true, email: true } });

    await this.prisma.auditLog.create({
      data: {
        syncId: randomUUID(),
        companyId: company.id,
        actorId: ctx.userId,
        action: 'support.session',
        entityType: store ? 'shop_store' : 'organization',
        entityId: store?.id ?? company.id,
        description: `فريق RVIOS (${staff?.displayName ?? staff?.email ?? 'موظف'}) فتح جلسة دعم${store ? ` لإدارة متجر «${store.name}»` : ''}`,
      },
    });

    return {
      accessToken: await this.jwt.signAsync({ sub: ctx.userId, companyId: company.id, support: true }, { expiresIn: SUPPORT_SESSION }),
      company,
      storeId: store?.id ?? null,
      expiresIn: SUPPORT_SESSION,
    };
  }
}
