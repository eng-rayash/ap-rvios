import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { VersionConflictError } from '../../meetings/meetings.service';
import { CreatePostDto, UpdatePostDto } from './dto';

@Injectable()
export class PostsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext, params?: { status?: number }) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsPost.findMany({
      where: {
        deletedAt: null,
        ...(params?.status !== undefined ? { status: params.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { category: true },
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const post = await db.cmsPost.findUnique({ where: { id }, include: { category: true } });
    if (!post || post.deletedAt) {
      throw new NotFoundException('المقال غير موجود');
    }
    return post;
  }

  create(ctx: TenantContext, input: CreatePostDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const status = input.status ?? 0;
    return db.cmsPost.create({
      data: tenantCreate<Prisma.CmsPostUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        title: input.title,
        titleEn: input.titleEn,
        slug: input.slug,
        description: input.description,
        content: input.content,
        metaDescription: input.metaDescription,
        keywords: input.keywords ?? [],
        tags: input.tags ?? [],
        heroImageUrl: input.heroImageUrl,
        heroImageAlt: input.heroImageAlt,
        readingTime: input.readingTime ?? 5,
        status,
        featured: input.featured ?? false,
        categoryId: input.categoryId,
        // النشر يُختم بتاريخه عند إنشاء المقال منشورًا مباشرة — لا يبقى فارغًا
        // بينما الحالة "منشورة"، فذلك يكذب على أي استعلام يفترض تلازمهما.
        publishedAt: status === 1 ? new Date() : undefined,
        createdBy: ctx.userId,
      }),
    });
  }

  async update(ctx: TenantContext, id: string, input: UpdatePostDto, expectedVersion?: number) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }

    // الانتقال إلى "منشورة" أول مرة يختم publishedAt؛ لا يُعاد ختمه عند
    // تعديلات لاحقة على مقال منشور بالفعل.
    const justPublished = input.status === 1 && current.status !== 1;

    return db.cmsPost.update({
      where: { id },
      data: {
        ...(input as Prisma.CmsPostUpdateInput),
        ...(justPublished ? { publishedAt: new Date() } : {}),
        version: { increment: 1 },
      },
    });
  }

  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);
    return db.cmsPost.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }
}
