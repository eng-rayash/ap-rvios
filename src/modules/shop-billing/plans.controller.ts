import { Body, Controller, Delete, Get, Put } from '@nestjs/common';

import { Platform, PlatformOnly, Tenant } from '../../common/tenant/tenant.guard';
import { PlatformContext, TenantContext } from '../../common/tenant/tenant-context';
import { PlansService } from './plans';

/** الباقات كما يراها التاجر — صفحة «الباقة والاشتراك» داخل لوحته (لا تُعرض في الموقع العام) */
@Controller('billing/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  get(@Tenant() _ctx: TenantContext) {
    return this.plans.catalog();
  }
}

/** إدارة الباقات: الأسعار لكل فترة، والحدود، والمزايا — فريق المنصة */
@PlatformOnly()
@Controller('platform/plans')
export class PlatformPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  get(@Platform() _p: PlatformContext) {
    return this.plans.catalog();
  }

  @Put()
  async save(@Platform() _p: PlatformContext, @Body() body: Record<string, unknown>) {
    await this.plans.save(body);
    return this.plans.catalog();
  }

  /** العودة إلى الافتراضي */
  @Delete()
  async reset(@Platform() _p: PlatformContext) {
    await this.plans.reset();
    return this.plans.catalog();
  }
}
