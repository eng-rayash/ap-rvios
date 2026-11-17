import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';

import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { AnswerQuestionDto } from './questions.dto';
import { ShopQuestionsService } from './questions.service';
import { ShopSection } from '../../../common/tenant/shop-sections';

/** أسئلة المنتجات — لوحة التاجر */
@ShopSection('products')
@Controller('shop/stores/:storeId/questions')
export class ShopQuestionsController {
  constructor(private readonly questions: ShopQuestionsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Query('status') status?: string) {
    const s = status !== undefined && status !== '' ? Number(status) : undefined;
    return this.questions.list(ctx, storeId, Number.isInteger(s) ? s : undefined);
  }

  @RequireRole(UserRole.Employee)
  @Patch(':id')
  answer(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnswerQuestionDto,
  ) {
    return this.questions.answer(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.Employee)
  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.questions.remove(ctx, storeId, id);
  }
}
