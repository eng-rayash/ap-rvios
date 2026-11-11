import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { Public } from '../../../common/tenant/tenant.guard';
import { SITE_WORKSPACE_SLUG } from '../site-organization.constant';

/** حقول المقال التي تظهر للزائر — لا معرّف شركة ولا من أنشأه. */
const PUBLIC_FIELDS = {
  id: true,
  title: true,
  titleEn: true,
  slug: true,
  description: true,
  metaDescription: true,
  keywords: true,
  tags: true,
  heroImageUrl: true,
  heroImageAlt: true,
  readingTime: true,
  featured: true,
  publishedAt: true,
  updatedAt: true,
  category: { select: { name: true, nameEn: true, slug: true } },
} as const;

/**
 * مدونة الموقع الرئيسي (rvios.com) للزوار — المقالات المنشورة لشركة الموقع
 * المحجوزة فقط. يكتبها الفريق من «الموقع والمدونة» في لوحة المنصة، والموقع
 * يقرؤها بجانب مقالاته المكتوبة في الكود.
 */
@Public()
@Controller('cms/public')
export class PublicPostsController {
  constructor(private readonly prisma: TenantPrismaService) {}

  private async siteId(): Promise<string | null> {
    const org = await this.prisma.organization.findFirst({ where: { workspaceSlug: SITE_WORKSPACE_SLUG }, select: { id: true } });
    return org?.id ?? null;
  }

  @Get('posts')
  async list(@Query('limit') limit?: string) {
    const companyId = await this.siteId();
    if (!companyId) return { posts: [] };
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const posts = await this.prisma.cmsPost.findMany({
      where: { companyId, status: 1, publishedAt: { lte: new Date() } },
      orderBy: { publishedAt: 'desc' },
      take,
      select: PUBLIC_FIELDS,
    });
    return { posts };
  }

  @Get('posts/:slug')
  async get(@Param('slug') slug: string) {
    const companyId = await this.siteId();
    if (!companyId) throw new NotFoundException('المقال غير موجود');
    const post = await this.prisma.cmsPost.findFirst({
      where: { companyId, slug, status: 1, publishedAt: { lte: new Date() } },
      select: { ...PUBLIC_FIELDS, content: true },
    });
    if (!post) throw new NotFoundException('المقال غير موجود');
    // عدّاد القراءات تقريبي ولا يُبطئ الصفحة
    void this.prisma.cmsPost.update({ where: { id: post.id }, data: { views: { increment: 1 } } }).catch(() => undefined);
    return post;
  }
}
