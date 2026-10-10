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
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

/** مسارات العملاء — يتبع نموذج `MeetingsController` حرفيًا. */
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext, @Query('since') since?: string) {
    const parsed = since ? new Date(since) : undefined;
    const valid =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;

    return this.clients.findAll(ctx, { since: valid });
  }

  @Get(':id')
  findOne(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.clients.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateClientDto) {
    return this.clients.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClientDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expected = ifMatch ? Number(ifMatch) : undefined;
    return this.clients.update(
      ctx,
      id,
      dto,
      Number.isFinite(expected) ? expected : undefined,
    );
  }

  @RequireRole(UserRole.DeptManager)
  @Delete(':id')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.clients.remove(ctx, id);
  }
}
