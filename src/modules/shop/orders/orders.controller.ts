import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { AdvanceOrderDto, ManualOrderDto, OrderPaymentDto, ZoneDto } from './orders.dto';
import { OrdersService } from './orders.service';
import { ZonesService } from './zones.service';
import { ShopSection, hideCost } from '../../../common/tenant/shop-sections';
import { PlanFeature } from '../plan-feature.guard';

function statusOf(status?: string) {
  const s = status !== undefined && status !== '' ? Number(status) : undefined;
  return Number.isInteger(s) ? s : undefined;
}

/** طلبات المتجر وعملاؤه ومناطق توصيله — لوحة التاجر. */
@Controller('shop/stores/:storeId')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly zones: ZonesService,
  ) {}

  @ShopSection('orders')
  @Get('orders')
  list(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('q') q?: string,
  ) {
    const p = page ? Number(page) : undefined;
    return this.orders.list(ctx, storeId, {
      status: statusOf(status),
      page: Number.isInteger(p) ? p : undefined,
      q: typeof q === 'string' ? q : undefined,
    });
  }

  /** بيانات العملاء دفعة واحدة: للمدير فأعلى كالدفع */
  @RequireRole(UserRole.DeptManager)
  @ShopSection('orders')
  @Get('orders/export')
  export(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.orders.export(ctx, storeId, { status: statusOf(status), q: typeof q === 'string' ? q : undefined });
  }

  @ShopSection('orders')
  @Get('orders/:id')
  get(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.get(ctx, storeId, id).then((o) => hideCost(ctx, o));
  }

  /** طلب يدوي (هاتف، واتساب، المحل) — يحجز المخزون ويحسب القسيمة كطلب المتجر */
  @RequireRole(UserRole.Employee)
  @ShopSection('orders')
  @PlanFeature('manualOrders')
  @Post('orders')
  createManual(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: ManualOrderDto,
  ) {
    return this.orders.createManual(ctx, storeId, dto);
  }

  @RequireRole(UserRole.Employee)
  @ShopSection('orders')
  @Patch('orders/:id')
  advance(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdvanceOrderDto,
  ) {
    return this.orders.advance(ctx, storeId, id, dto.status, dto.reason ?? '');
  }

  @RequireRole(UserRole.DeptManager)
  @ShopSection('orders')
  @Patch('orders/:id/payment')
  payment(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderPaymentDto,
  ) {
    return this.orders.setPayment(ctx, storeId, id, dto.paid);
  }

  @ShopSection('customers')
  @Get('customers')
  customers(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.orders.customers(ctx, storeId);
  }

  // ── مناطق التوصيل ───────────────────────────────────────
  @Get('zones')
  zonesList(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.zones.list(ctx, storeId);
  }

  @RequireRole(UserRole.DeptManager)
  @Post('zones')
  zoneCreate(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: ZoneDto,
  ) {
    return this.zones.create(ctx, storeId, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Patch('zones/:id')
  zoneUpdate(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ZoneDto,
  ) {
    return this.zones.update(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete('zones/:id')
  zoneRemove(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.zones.remove(ctx, storeId, id);
  }
}
