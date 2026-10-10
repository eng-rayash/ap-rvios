import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { AddMemberDto, ChangePasswordDto, UpdateMemberDto, UpdateProfileDto } from './dto';
import { SITE_WORKSPACE_SLUG } from '../cms/site-organization.constant';

/**
 * سياق الجلسة وفريق الشركة — ما تحتاجه الواجهة لرسم مساحة العمل الصحيحة
 * لكل نوع مستخدم (تاجر، مدير منصة، مدير الموقع، موظف…).
 *
 * الواجهة تستعمله للرسم لا للحراسة: المنع الفعلي في كل مسار على حدة.
 */
@Controller()
export class WorkspaceController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** من أنا، وفي أي مساحة أعمل، وماذا يحقّ لي رؤيته في القائمة. */
  @Get('auth/context')
  async context(@Tenant() ctx: TenantContext) {
    const [user, company, stores] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: ctx.userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          isPlatformStaff: true,
          platformRole: true,
        },
      }),
      this.prisma.organization.findUnique({
        where: { id: ctx.companyId },
        select: {
          id: true,
          name: true,
          workspaceSlug: true,
          planType: true,
          subscriptionStatus: true,
          storeSlots: true,
        },
      }),
      this.prisma.shopStore.count({ where: { companyId: ctx.companyId } }),
    ]);

    return {
      user: user && {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      company,
      role: ctx.role,
      platformRole: user?.isPlatformStaff ? (user.platformRole ?? 0) : null,
      isSite: company?.workspaceSlug === SITE_WORKSPACE_SLUG,
      storeCount: stores,
    };
  }

  /** أعضاء شركتي — للفريق والأدوار. */
  @Get('team/members')
  async members(@Tenant() ctx: TenantContext) {
    const rows = await this.prisma.membership.findMany({
      where: { organizationId: ctx.companyId, deletedAt: null },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        role: true,
        isActive: true,
        joinedAt: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            lastLoginAt: true,
          },
        },
      },
    });
    return { members: rows };
  }

  /**
   * إضافة عضو للشركة. لا يجوز منح دور أعلى من دور المُضيف — وإلا صار كل
   * مدير مالكًا. البريد القائم يُربط بحسابه الحالي دون المساس بكلمة مروره.
   */
  @RequireRole(UserRole.Admin)
  @Post('team/members')
  async addMember(@Tenant() ctx: TenantContext, @Body() dto: AddMemberDto) {
    if (dto.role < ctx.role) throw new ForbiddenException('لا يمكنك منح دور أعلى من دورك');
    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      const dup = await this.prisma.membership.findFirst({
        where: { userId: existing.id, organizationId: ctx.companyId, deletedAt: null },
      });
      if (dup) throw new ConflictException('هذا المستخدم عضو في الشركة بالفعل');
    } else if (!dto.password) {
      throw new BadRequestException('حدّد كلمة مرور مؤقتة للحساب الجديد');
    }

    const userId =
      existing?.id ??
      (
        await this.prisma.user.create({
          data: {
            syncId: randomUUID(),
            email,
            displayName: dto.displayName.trim(),
            passwordHash: await bcrypt.hash(dto.password!, 12),
          },
        })
      ).id;

    const m = await this.prisma.membership.create({
      data: {
        syncId: randomUUID(),
        userId,
        organizationId: ctx.companyId,
        role: dto.role,
        joinedAt: new Date(),
      },
      select: { id: true },
    });
    return { id: m.id };
  }

  /** تغيير دور عضو أو إيقافه. لا تعديل لنفسك ولا لمن هو أعلى منك. */
  @RequireRole(UserRole.Admin)
  @Patch('team/members/:id')
  async updateMember(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemberDto,
  ) {
    const target = await this.prisma.membership.findFirst({
      where: { id, organizationId: ctx.companyId, deletedAt: null },
    });
    if (!target) throw new NotFoundException('العضو غير موجود');
    if (target.id === ctx.membershipId) throw new ForbiddenException('لا تعدّل عضويتك بنفسك');
    if (target.role === UserRole.Owner) throw new ForbiddenException('لا يُعدَّل المالك');
    if (target.role <= ctx.role && ctx.role !== UserRole.Owner) {
      throw new ForbiddenException('لا تعدّل من هو بمستواك أو أعلى');
    }
    if (dto.role !== undefined && dto.role < ctx.role) {
      throw new ForbiddenException('لا يمكنك منح دور أعلى من دورك');
    }

    await this.prisma.membership.update({
      where: { id },
      data: {
        ...(dto.role !== undefined && { role: dto.role }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    return { ok: true };
  }

  /** بياناتي الشخصية كما تُحرَّر في الإعدادات. */
  @Get('me/profile')
  async profile(@Tenant() ctx: TenantContext) {
    const u = await this.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { id: true, email: true, displayName: true, phone: true, avatarUrl: true, language: true, timezone: true },
    });
    return u;
  }

  /** تعديل بياناتي. البريد لا يُعدَّل من هنا (هوية الدخول). */
  @Patch('me/profile')
  async updateProfile(@Tenant() ctx: TenantContext, @Body() dto: UpdateProfileDto) {
    if (dto.avatarUrl && !/^https?:\/\//i.test(dto.avatarUrl)) {
      throw new BadRequestException('رابط الصورة يجب أن يبدأ بـ http أو https');
    }
    return this.prisma.user.update({
      where: { id: ctx.userId },
      data: {
        ...(dto.displayName !== undefined && { displayName: dto.displayName.trim() }),
        ...(dto.phone !== undefined && { phone: dto.phone.trim() || null }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl.trim() || null }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      },
      select: { id: true, email: true, displayName: true, phone: true, avatarUrl: true, language: true, timezone: true },
    });
  }

  /**
   * تغيير كلمة المرور بعد التحقق من الحالية. يُبطل كل الجلسات السابقة (رمز
   * مسروق لا يبقى صالحًا)، ويعيد رمزًا جديدًا تستمر به الجلسة الحالية.
   */
  @Post('me/password')
  async changePassword(@Tenant() ctx: TenantContext, @Body() dto: ChangePasswordDto) {
    const u = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { passwordHash: true } });
    if (!u || !(await bcrypt.compare(dto.currentPassword, u.passwordHash))) {
      throw new BadRequestException('كلمة المرور الحالية غير صحيحة');
    }
    await this.prisma.user.update({
      where: { id: ctx.userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12), passwordChangedAt: new Date() },
    });
    const accessToken = await this.jwt.signAsync({ sub: ctx.userId, companyId: ctx.companyId });
    return { ok: true, accessToken };
  }
}
