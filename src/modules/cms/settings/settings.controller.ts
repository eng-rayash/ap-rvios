import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { SettingsService } from './settings.service';
import { UpsertSettingDto } from './dto';

@Controller('cms/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext) {
    return this.settings.findAll(ctx);
  }

  @Get(':key')
  findByKey(@Tenant() ctx: TenantContext, @Param('key') key: string) {
    return this.settings.findByKey(ctx, key);
  }

  @Post()
  upsert(@Tenant() ctx: TenantContext, @Body() dto: UpsertSettingDto) {
    return this.settings.upsert(ctx, dto);
  }
}
