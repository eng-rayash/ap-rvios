import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';

class SetStaffDto {
  /** 0=دعم · 1=فوترة · 2=مدير عام · null=ليس من فريق المنصة */
  @IsOptional()
  @IsIn([0, 1, 2, null])
  role!: 0 | 1 | 2 | null;
}

/**
 * حسابات المستخدمين عبر كل الشركات، وصلاحيات فريق المنصة. المنح والسحب للمدير العام وحده،
 * ولا يغيّر أحد صلاحيته بنفسه — فلا تُفقد آخر صلاحية إدارة بنقرة خاطئة.
 */
@PlatformOnly()
@Controller('platform/users')
export class PlatformUsersController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  async list(@Platform() _ctx: PlatformContext, @Query('q') q?: string, @Query('staff') staff?: string) {
    const term = q?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(staff === '1' ? { isPlatformStaff: true } : {}),
        ...(term ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { displayName: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, email: true, displayName: true, createdAt: true, lastLoginAt: true, emailVerifiedAt: true,
        isPlatformStaff: true, platformRole: true, googleSub: true,
        memberships: { where: { isActive: true, deletedAt: null }, select: { role: true, organization: { select: { id: true, name: true } } } },
      },
    });
    return users.map(({ googleSub, memberships, ...u }) => ({
      ...u,
      google: !!googleSub,
      companies: memberships.map((m) => ({ ...m.organization, role: m.role })),
    }));
  }

  @Patch(':id/staff')
  async setStaff(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStaffDto) {
    if (ctx.platformRole !== 2) throw new ForbiddenException('صلاحيات فريق المنصة يمنحها المدير العام وحده');
    if (id === ctx.userId) throw new BadRequestException('لا تغيّر صلاحيتك بنفسك — يغيّرها مدير عام آخر');
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
    if (!user || user.deletedAt) throw new NotFoundException('الحساب غير موجود');
    const role = dto.role ?? null;
    return this.prisma.user.update({
      where: { id },
      data: { isPlatformStaff: role !== null, platformRole: role },
      select: { id: true, isPlatformStaff: true, platformRole: true },
    });
  }
}
