import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { CouponDto } from './coupons.dto';
import { CouponsService } from './coupons.service';
import { ShopSection } from '../../../common/tenant/shop-sections';

/** قسائم الخصم — لوحة التاجر (القراءة للجميع، والتعديل للمدير فأعلى كمناطق التوصيل) */
@ShopSection('marketing')
@Controller('shop/stores/:storeId/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.coupons.list(ctx, storeId);
  }

  @RequireRole(UserRole.DeptManager)
  @Post()
  create(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: CouponDto,
  ) {
    return this.coupons.create(ctx, storeId, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CouponDto,
  ) {
    return this.coupons.update(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete(':id')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.coupons.remove(ctx, storeId, id);
  }
}
