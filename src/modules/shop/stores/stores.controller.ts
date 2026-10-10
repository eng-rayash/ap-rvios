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

import { Platform, PlatformOnly, RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import {
  PlatformContext,
  TenantContext,
  UserRole,
} from '../../../common/tenant/tenant-context';
import { CreateStoreDto, SetStoreStatusDto, UpdateStoreDto } from './stores.dto';
import { StoresService } from './stores.service';

/** متاجر الشركة — قراءة لأي عضو، والكتابة للإدارة فما فوق. */
@Controller('shop/stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  list(@Tenant() ctx: TenantContext) {
    return this.stores.list(ctx);
  }

  /** فحص فوري لتوفر الرابط — قبل `:storeId` كي لا يُلتقط اسمًا لمتجر. */
  @Get('slug/check')
  checkSlug(
    @Tenant() _ctx: TenantContext,
    @Query('q') q = '',
    @Query('except') except?: string,
  ) {
    if (!q.trim()) {
      return { slug: '', ok: false, reason: 'اكتب اسم متجرك', suggestion: null };
    }
    return this.stores.checkSlug(q, except);
  }

  @Get(':storeId')
  get(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.stores.get(ctx, storeId);
  }

  @RequireRole(UserRole.Admin)
  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateStoreDto) {
    return this.stores.create(ctx, dto);
  }

  @RequireRole(UserRole.Admin)
  @Patch(':storeId')
  update(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: UpdateStoreDto,
  ) {
    return this.stores.update(ctx, storeId, dto);
  }

  @RequireRole(UserRole.Admin)
  @Delete(':storeId')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.stores.remove(ctx, storeId);
  }
}

/** متاجر كل الشركات — فريق المنصة فقط. */
@PlatformOnly()
@Controller('platform/shop-stores')
export class PlatformStoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  list(@Platform() _ctx: PlatformContext, @Query('q') q?: string) {
    return this.stores.platformList(q);
  }

  @Patch(':storeId/status')
  status(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SetStoreStatusDto,
  ) {
    return this.stores.platformSetStatus(storeId, dto.suspended);
  }

  /** شارة «موثَّق» — تمنحها الإدارة بعد المراجعة. */
  @Patch(':storeId/verified')
  verified(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { verified: boolean },
  ) {
    return this.stores.platformSetVerified(storeId, !!body.verified);
  }
}
