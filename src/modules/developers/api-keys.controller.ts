import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto';

/** مفاتيح API — مدير فأعلى فقط، لأنها تمنح وصولًا برمجيًا خارجيًا لبيانات الشركة. */
@RequireRole(UserRole.Admin)
@Controller('developer/keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@Tenant() ctx: TenantContext) {
    return this.keys.list(ctx);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(ctx, dto);
  }

  @Delete(':id')
  revoke(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.keys.revoke(ctx, id);
  }
}
