import { Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';

/**
 * AZM — إدارة الشركات، عبر كل المستأجرين
 *
 * ⚠ الاستثناء الوحيد المتعمَّد من `forTenant()` في كل الكودبيس: هذه
 * الخدمة تُستدعى فقط من متحكّمات `@PlatformOnly()`، وعملها بالتعريف
 * أن ترى كل شركة لا شركة واحدة. `forTenant()` يفرض العكس تمامًا، فاستخدامه
 * هنا كان سيكون خطأً لا حماية زائدة.
 *
 * لا تستدعِ هذه الخدمة من أي مسار غير معلَّم بـ`@PlatformOnly()`.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async findAll() {
    const orgs = await this.prisma.organization.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        companyCode: true,
        workspaceSlug: true,
        planType: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        country: true,
        currency: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
    });

    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      companyCode: o.companyCode,
      workspaceSlug: o.workspaceSlug,
      planType: o.planType,
      subscriptionStatus: o.subscriptionStatus,
      trialEndsAt: o.trialEndsAt,
      country: o.country,
      currency: o.currency,
      createdAt: o.createdAt,
      memberCount: o._count.memberships,
    }));
  }

  async findOne(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        memberships: {
          where: { deletedAt: null },
          select: {
            id: true,
            role: true,
            isActive: true,
            joinedAt: true,
            user: { select: { id: true, displayName: true, email: true } },
          },
        },
      },
    });

    if (!org || org.deletedAt) {
      throw new NotFoundException('الشركة غير موجودة');
    }
    return org;
  }

  async updatePlan(
    id: string,
    input: {
      planType?: number;
      subscriptionStatus?: number;
      trialEndsAt?: string;
      storeSlots?: number;
    },
  ) {
    await this.findOne(id);

    return this.prisma.organization.update({
      where: { id },
      data: {
        planType: input.planType,
        subscriptionStatus: input.subscriptionStatus,
        trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : undefined,
        storeSlots: input.storeSlots,
      },
    });
  }
}
