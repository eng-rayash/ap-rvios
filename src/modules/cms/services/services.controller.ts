import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { CmsServicesService } from './services.service';
import { CreateServiceDto, UpdateServiceDto } from './dto';

@Controller('cms/services')
export class CmsServicesController {
  constructor(private readonly services: CmsServicesService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext) {
    return this.services.findAll(ctx);
  }

  @Get(':id')
  findOne(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateServiceDto) {
    return this.services.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expected = ifMatch ? Number(ifMatch) : undefined;
    return this.services.update(ctx, id, dto, Number.isFinite(expected) ? expected : undefined);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.remove(ctx, id);
  }
}
