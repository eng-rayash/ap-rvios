import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { MediaService } from './media.service';
import { CreateMediaDto } from './dto';

@Controller('cms/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext) {
    return this.media.findAll(ctx);
  }

  @Get(':id')
  findOne(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateMediaDto) {
    return this.media.create(ctx, dto);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.remove(ctx, id);
  }
}
