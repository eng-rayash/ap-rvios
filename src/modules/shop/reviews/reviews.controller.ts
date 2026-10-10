import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { UpdateReviewDto } from './reviews.dto';
import { ShopReviewsService } from './reviews.service';

/** تقييمات منتجات المتجر — للتاجر: قراءتها، وإخفاؤها أو نشرها، والردّ عليها. */
@Controller('shop/stores/:storeId/reviews')
export class ShopReviewsController {
  constructor(private readonly reviews: ShopReviewsService) {}

  @Get()
  list(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('status') status?: string,
  ) {
    const s = status !== undefined && status !== '' ? Number(status) : undefined;
    return this.reviews.list(ctx, storeId, s !== undefined && Number.isInteger(s) ? s : undefined);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviews.update(ctx, storeId, id, dto);
  }
}
