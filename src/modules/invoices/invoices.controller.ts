import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { InvoicesService } from './invoices.service';

/** مسارات الفواتير — يتبع نموذج `MeetingsController` حرفيًا. */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext, @Query('since') since?: string) {
    const parsed = since ? new Date(since) : undefined;
    const valid =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;

    return this.invoices.findAll(ctx, { since: valid });
  }

  @Get(':id')
  findOne(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invoices.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvoiceDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expected = ifMatch ? Number(ifMatch) : undefined;
    return this.invoices.update(
      ctx,
      id,
      dto,
      Number.isFinite(expected) ? expected : undefined,
    );
  }

  /** الفواتير سجلّ مالي — الحذف يتطلّب مديرًا ماليًا فأعلى. */
  @RequireRole(UserRole.FinanceManager)
  @Delete(':id')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invoices.remove(ctx, id);
  }
}
