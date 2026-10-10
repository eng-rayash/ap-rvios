import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ProjectCategoriesService } from './project-categories.service';
import { CreateProjectCategoryDto, UpdateProjectCategoryDto } from './dto';

@Controller('cms/project-categories')
export class ProjectCategoriesController {
  constructor(private readonly categories: ProjectCategoriesService) {}

  @Get()
  findAll(@Tenant() ctx: TenantContext) {
    return this.categories.findAll(ctx);
  }

  @Get(':id')
  findOne(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateProjectCategoryDto) {
    return this.categories.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectCategoryDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expected = ifMatch ? Number(ifMatch) : undefined;
    return this.categories.update(ctx, id, dto, Number.isFinite(expected) ? expected : undefined);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.remove(ctx, id);
  }
}
