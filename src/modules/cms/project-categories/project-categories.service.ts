import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { VersionConflictError } from '../../meetings/meetings.service';
import { CreateProjectCategoryDto, UpdateProjectCategoryDto } from './dto';

@Injectable()
export class ProjectCategoriesService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsProjectCategory.findMany({
      where: { deletedAt: null },
      orderBy: { order: 'asc' },
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const category = await db.cmsProjectCategory.findUnique({ where: { id } });
    if (!category || category.deletedAt) {
      throw new NotFoundException('تصنيف المشاريع غير موجود');
    }
    return category;
  }

  create(ctx: TenantContext, input: CreateProjectCategoryDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsProjectCategory.create({
      data: tenantCreate<Prisma.CmsProjectCategoryUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        name: input.name,
        nameEn: input.nameEn,
        slug: input.slug,
        order: input.order ?? 0,
      }),
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateProjectCategoryDto,
    expectedVersion?: number,
  ) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }
    return db.cmsProjectCategory.update({
      where: { id },
      data: { ...(input as Prisma.CmsProjectCategoryUpdateInput), version: { increment: 1 } },
    });
  }

  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);
    return db.cmsProjectCategory.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }
}
