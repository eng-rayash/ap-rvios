import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { VersionConflictError } from '../../meetings/meetings.service';
import { CreateServiceDto, UpdateServiceDto } from './dto';

/** خدمات الموقع (العروض التسويقية) — لا خلط بينها وبين وحدة أعمال أخرى. */
@Injectable()
export class CmsServicesService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsService.findMany({
      where: { deletedAt: null },
      orderBy: { order: 'asc' },
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const service = await db.cmsService.findUnique({ where: { id } });
    if (!service || service.deletedAt) {
      throw new NotFoundException('الخدمة غير موجودة');
    }
    return service;
  }

  create(ctx: TenantContext, input: CreateServiceDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsService.create({
      data: tenantCreate<Prisma.CmsServiceUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        title: input.title,
        titleEn: input.titleEn,
        slug: input.slug,
        description: input.description,
        descriptionEn: input.descriptionEn,
        icon: input.icon,
        features: input.features ?? [],
        order: input.order ?? 0,
        status: input.status ?? 0,
      }),
    });
  }

  async update(ctx: TenantContext, id: string, input: UpdateServiceDto, expectedVersion?: number) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }
    return db.cmsService.update({
      where: { id },
      data: { ...(input as Prisma.CmsServiceUpdateInput), version: { increment: 1 } },
    });
  }

  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);
    return db.cmsService.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }
}
