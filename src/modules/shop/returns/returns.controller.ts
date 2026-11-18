import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { CreateReturnDto, UpdateReturnDto } from './returns.dto';
import { ShopReturnsService } from './returns.service';
import { ShopSection } from '../../../common/tenant/shop-sections';
import { PlanFeature } from '../plan-feature.guard';

/** المرتجعات — لوحة التاجر */
@ShopSection('orders')
@PlanFeature('returns')
@Controller('shop/stores/:storeId/returns')
export class ShopReturnsController {
  constructor(private readonly returns: ShopReturnsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Query('status') status?: string) {
    const s = status !== undefined && status !== '' ? Number(status) : undefined;
    return this.returns.list(ctx, storeId, Number.isInteger(s) ? s : undefined);
  }

  @RequireRole(UserRole.Employee)
  @Post()
  create(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: CreateReturnDto) {
    return this.returns.create(ctx, storeId, dto);
  }

  @RequireRole(UserRole.Employee)
  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReturnDto,
  ) {
    return this.returns.update(ctx, storeId, id, dto);
  }
}
