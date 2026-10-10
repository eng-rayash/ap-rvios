import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import { PlatformInvoicesService } from './platform-invoices.service';
import { CreatePlatformInvoiceDto } from './dto/create-platform-invoice.dto';
import { ReviewPlatformInvoiceDto } from './dto/review-platform-invoice.dto';

/** مسارات فواتير الاشتراك — فريق منصة RVIOS فقط. */
@PlatformOnly()
@Controller('platform/invoices')
export class PlatformInvoicesController {
  constructor(private readonly invoices: PlatformInvoicesService) {}

  @Get()
  findAll(@Platform() _ctx: PlatformContext, @Query('status') status?: string) {
    const parsed = status !== undefined ? Number(status) : undefined;
    return this.invoices.findAll(Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get(':id')
  findOne(
    @Platform() _ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invoices.findOne(id);
  }

  @Post()
  create(@Platform() _ctx: PlatformContext, @Body() dto: CreatePlatformInvoiceDto) {
    return this.invoices.create(dto);
  }

  @Patch(':id/review')
  review(
    @Platform() ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewPlatformInvoiceDto,
  ) {
    return this.invoices.review(id, ctx, dto);
  }
}
