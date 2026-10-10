import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto';
import { WebhooksService } from './webhooks.service';

/** خطافات الويب — مدير فأعلى: ترسل بيانات العملاء والطلبات إلى عناوين خارجية. */
@RequireRole(UserRole.Admin)
@Controller('developer/webhooks')
export class WebhooksController {
  constructor(private readonly hooks: WebhooksService) {}

  @Get('events')
  events() {
    return this.hooks.events();
  }

  @Get()
  list(@Tenant() ctx: TenantContext) {
    return this.hooks.list(ctx);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateWebhookDto) {
    return this.hooks.create(ctx, dto);
  }

  @Patch(':id')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWebhookDto) {
    return this.hooks.update(ctx, id, dto);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.remove(ctx, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotate(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.rotateSecret(ctx, id);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.sendTest(ctx, id);
  }

  @Get(':id/deliveries')
  deliveries(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.deliveries(ctx, id);
  }

  @Post('deliveries/:deliveryId/redeliver')
  @HttpCode(200)
  redeliver(@Tenant() ctx: TenantContext, @Param('deliveryId', ParseUUIDPipe) deliveryId: string) {
    return this.hooks.redeliver(ctx, deliveryId);
  }
}
