import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';

@Controller('cms/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext, @Query('status') status?: string) {
    const parsed = status !== undefined ? Number(status) : undefined;
    return this.projects.findAll(ctx, { status: Number.isFinite(parsed) ? parsed : undefined });
  }

  @Get(':id')
  findOne(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateProjectDto) {
    return this.projects.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expected = ifMatch ? Number(ifMatch) : undefined;
    return this.projects.update(ctx, id, dto, Number.isFinite(expected) ? expected : undefined);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.remove(ctx, id);
  }
}
