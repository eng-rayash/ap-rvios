import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

import { Platform, PlatformOnly, Tenant } from '../../common/tenant/tenant.guard';
import { PlatformContext, TenantContext } from '../../common/tenant/tenant-context';
import { PlatformAlerts } from './platform-alerts.service';
import { PushService } from './push.service';

export class RegisterDeviceDto {
  @IsString()
  @Length(20, 400)
  token!: string;

  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: string;
}

/**
 * أجهزة تطبيق عزم للتاجر — تصله طلبات متجره وتنبيهاته على الهاتف.
 * الجهاز يُربط بالشركة النشطة في الجلسة، فمن يملك شركتين يختار أيهما تُزعجه.
 */
@Controller('notify/devices')
export class DevicesController {
  constructor(private readonly push: PushService) {}

  @Post()
  register(@Tenant() ctx: TenantContext, @Body() dto: RegisterDeviceDto) {
    return this.push.register(ctx.userId, { token: dto.token, platform: dto.platform, app: 'azm', companyId: ctx.companyId });
  }

  @Delete(':token')
  remove(@Tenant() ctx: TenantContext, @Param('token') token: string) {
    return this.push.unregister(ctx.userId, token);
  }
}

/** صندوق تنبيهات فريق المنصة، وأجهزة تطبيق RVOS. */
@PlatformOnly()
@Controller('platform')
export class PlatformAlertsController {
  constructor(
    private readonly alerts: PlatformAlerts,
    private readonly push: PushService,
  ) {}

  @Get('alerts')
  list(@Platform() _ctx: PlatformContext, @Query('unread') unread?: string, @Query('page') page?: string) {
    return this.alerts.list({ unread: unread === '1', page: Number(page) || 1 });
  }

  @Get('alerts/count')
  count(@Platform() _ctx: PlatformContext) {
    return this.alerts.unread();
  }

  @Patch('alerts/:id/read')
  read(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.markRead(id, ctx.userId);
  }

  @Post('alerts/read-all')
  readAll(@Platform() ctx: PlatformContext) {
    return this.alerts.markAllRead(ctx.userId);
  }

  @Get('notify/status')
  status(@Platform() _ctx: PlatformContext) {
    return { push: this.push.status() };
  }

  @Post('devices')
  register(@Platform() ctx: PlatformContext, @Body() dto: RegisterDeviceDto) {
    return this.push.register(ctx.userId, { token: dto.token, platform: dto.platform, app: 'rvos' });
  }

  @Delete('devices/:token')
  remove(@Platform() ctx: PlatformContext, @Param('token') token: string) {
    return this.push.unregister(ctx.userId, token);
  }
}
