import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { CreateMediaDto } from './dto';

@Injectable()
export class MediaService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsMedia.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const media = await db.cmsMedia.findUnique({ where: { id } });
    if (!media || media.deletedAt) {
      throw new NotFoundException('الوسيط غير موجود');
    }
    return media;
  }

  create(ctx: TenantContext, input: CreateMediaDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsMedia.create({
      data: tenantCreate<Prisma.CmsMediaUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        url: input.url,
        filename: input.filename,
        originalName: input.originalName,
        mimeType: input.mimeType,
        size: input.size,
        type: input.type ?? 0,
        createdBy: ctx.userId,
      }),
    });
  }

  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);
    return db.cmsMedia.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
