import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { VersionConflictError } from '../../meetings/meetings.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto';

/** تصنيفات المدوّنة — يتبع نموذج `MeetingsService` حرفيًا. */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsCategory.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const category = await db.cmsCategory.findUnique({ where: { id } });
    if (!category || category.deletedAt) {
      throw new NotFoundException('التصنيف غير موجود');
    }
    return category;
  }

  create(ctx: TenantContext, input: CreateCategoryDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsCategory.create({
      data: tenantCreate<Prisma.CmsCategoryUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        name: input.name,
        nameEn: input.nameEn,
        slug: input.slug,
      }),
    });
  }

  async update(ctx: TenantContext, id: string, input: UpdateCategoryDto, expectedVersion?: number) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }
    return db.cmsCategory.update({
      where: { id },
      data: { ...(input as Prisma.CmsCategoryUpdateInput), version: { increment: 1 } },
    });
  }

  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);
    return db.cmsCategory.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }
}
