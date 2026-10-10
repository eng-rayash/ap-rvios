import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { AnalyticsService } from './analytics.service';

/** النظرة العامة والتحليلات والتقارير — قراءة فقط. */
@Controller('shop/stores/:storeId')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.analytics.overview(ctx, storeId);
  }

  @Get('analytics')
  report(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('days') days?: string,
  ) {
    return this.analytics.analytics(ctx, storeId, Number(days) || 30);
  }

  @Get('low-stock')
  lowStock(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.analytics.lowStock(ctx, storeId);
  }
}
