import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { VersionConflictError } from '../../meetings/meetings.service';
import { CreateProjectDto, ProjectImageDto, ProjectMetricDto, UpdateProjectDto } from './dto';

type TenantDb = ReturnType<TenantPrismaService['forTenant']>;

const PROJECT_INCLUDE = {
  category: true,
  gallery: { orderBy: { order: 'asc' as const } },
  metrics: { orderBy: { order: 'asc' as const } },
  services: { include: { service: true } },
};

/**
 * AZM — مشاريع الموقع (معرض الأعمال)
 *
 * المعرض والمؤشرات وربط الخدمات كيانات متداخلة لا CRUD مستقل — تُستبدَل
 * بالكامل عند كل تعديل يذكرها (حذف ثم إعادة إنشاء)، لا تُدمَج جزئيًا.
 * أبسط من تتبّع أيّ عنصر أُضيف أو حُذف أو أُعيد ترتيبه، وصحيح دائمًا:
 * ما يصل من العميل هو الحالة الكاملة المطلوبة، لا فرقًا عنها.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext, params?: { status?: number }) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsProject.findMany({
      where: {
        deletedAt: null,
        ...(params?.status !== undefined ? { status: params.status } : {}),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
      include: PROJECT_INCLUDE,
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const project = await db.cmsProject.findUnique({ where: { id }, include: PROJECT_INCLUDE });
    if (!project || project.deletedAt) {
      throw new NotFoundException('المشروع غير موجود');
    }
    return project;
  }

  async create(ctx: TenantContext, input: CreateProjectDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const projectId = randomUUID();
    const status = input.status ?? 0;

    // مُصرَّح بلا نوعه المستنتَج تلقائيًا: النوع المستنتَج من أول عنصر
    // (متابعة علاقات CmsProject السلسة) لا يقبل عناصر النماذج الأخرى
    // بعده رغم أن كل عملية Prisma صالحة فعلًا داخل `$transaction`.
    const operations: Prisma.PrismaPromise<unknown>[] = [
      db.cmsProject.create({
        data: tenantCreate<Prisma.CmsProjectUncheckedCreateInput>({
          id: projectId,
          syncId: input.syncId ?? randomUUID(),
          slug: input.slug,
          title: input.title,
          titleEn: input.titleEn,
          summary: input.summary,
          description: input.description,
          challenge: input.challenge,
          solution: input.solution,
          outcome: input.outcome,
          approach: (input.approach ?? []) as Prisma.InputJsonValue,
          client: input.client,
          clientLogoUrl: input.clientLogoUrl,
          industry: input.industry,
          year: input.year,
          durationMonths: input.durationMonths,
          role: input.role,
          teamSize: input.teamSize,
          technologies: input.technologies ?? [],
          categoryId: input.categoryId,
          coverImageUrl: input.coverImageUrl,
          coverImageAlt: input.coverImageAlt,
          coverBlurHash: input.coverBlurHash,
          testimonialQuote: input.testimonialQuote,
          testimonialAuthor: input.testimonialAuthor,
          testimonialRole: input.testimonialRole,
          testimonialAvatarUrl: input.testimonialAvatarUrl,
          liveUrl: input.liveUrl,
          repoUrl: input.repoUrl,
          featured: input.featured ?? false,
          order: input.order ?? 0,
          status,
          publishedAt: status === 1 ? new Date() : undefined,
          metaTitle: input.metaTitle,
          metaDescription: input.metaDescription,
          ogImageUrl: input.ogImageUrl,
        }),
      }),
      ...this.galleryOperations(db, projectId, input.gallery),
      ...this.metricOperations(db, projectId, input.metrics),
      ...this.serviceLinkOperations(db, projectId, input.serviceIds),
    ];

    await db.$transaction(operations);
    return this.findOne(ctx, projectId);
  }

  async update(ctx: TenantContext, id: string, input: UpdateProjectDto, expectedVersion?: number) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }

    const justPublished = input.status === 1 && current.status !== 1;
    const {
      gallery,
      metrics,
      serviceIds,
      approach,
      ...rest
    } = input;

    const operations: Prisma.PrismaPromise<unknown>[] = [
      db.cmsProject.update({
        where: { id },
        data: {
          ...(rest as Prisma.CmsProjectUpdateInput),
          ...(approach !== undefined ? { approach: approach as Prisma.InputJsonValue } : {}),
          ...(justPublished ? { publishedAt: new Date() } : {}),
          version: { increment: 1 },
        },
      }),
    ];

    // كل حقل متداخل يُستبدَل كليًا فقط إن ذُكر في الطلب — تعديل حقل
    // آخر من المشروع لا يمسح معرضه سهوًا لمجرد أن الطلب لم يذكره.
    if (gallery !== undefined) {
      operations.push(db.cmsProjectImage.deleteMany({ where: { projectId: id } }));
      operations.push(...this.galleryOperations(db, id, gallery));
    }
    if (metrics !== undefined) {
      operations.push(db.cmsProjectMetric.deleteMany({ where: { projectId: id } }));
      operations.push(...this.metricOperations(db, id, metrics));
    }
    if (serviceIds !== undefined) {
      operations.push(db.cmsProjectService.deleteMany({ where: { projectId: id } }));
      operations.push(...this.serviceLinkOperations(db, id, serviceIds));
    }

    await db.$transaction(operations);
    return this.findOne(ctx, id);
  }

  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);
    return db.cmsProject.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }

  private galleryOperations(
    db: TenantDb,
    projectId: string,
    gallery?: ProjectImageDto[],
  ): Prisma.PrismaPromise<unknown>[] {
    return (gallery ?? []).map((img, i) =>
      db.cmsProjectImage.create({
        data: tenantCreate<Prisma.CmsProjectImageUncheckedCreateInput>({
          syncId: randomUUID(),
          projectId,
          url: img.url,
          alt: img.alt,
          caption: img.caption,
          width: img.width,
          height: img.height,
          blurHash: img.blurHash,
          order: img.order ?? i,
        }),
      }),
    );
  }

  private metricOperations(
    db: TenantDb,
    projectId: string,
    metrics?: ProjectMetricDto[],
  ): Prisma.PrismaPromise<unknown>[] {
    return (metrics ?? []).map((m, i) =>
      db.cmsProjectMetric.create({
        data: tenantCreate<Prisma.CmsProjectMetricUncheckedCreateInput>({
          syncId: randomUUID(),
          projectId,
          label: m.label,
          value: m.value,
          unit: m.unit,
          direction: m.direction ?? 0,
          order: m.order ?? i,
        }),
      }),
    );
  }

  private serviceLinkOperations(
    db: TenantDb,
    projectId: string,
    serviceIds?: string[],
  ): Prisma.PrismaPromise<unknown>[] {
    return (serviceIds ?? []).map((serviceId) =>
      db.cmsProjectService.create({
        data: tenantCreate<Prisma.CmsProjectServiceUncheckedCreateInput>({
          syncId: randomUUID(),
          projectId,
          serviceId,
        }),
      }),
    );
  }
}
