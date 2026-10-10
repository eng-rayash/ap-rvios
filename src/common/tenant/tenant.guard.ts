import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { hashApiKey } from '../security/api-key.util';
import { TenantContext, PlatformContext, UserRole, hasRole } from './tenant-context';

/** المسارات المعلَّمة بهذا لا تحتاج مصادقة — التسجيل والدخول. */
export const PUBLIC_KEY = 'azm:public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

const STALE_SESSION = 'انتهت الجلسة بعد تغيير كلمة المرور — سجّل دخولك من جديد';

/**
 * هل صدر الرمز قبل آخر تغيير لكلمة المرور؟ المقارنة بالثواني لأن `iat` بالثواني:
 * الرمز الجديد الذي يُصدَر مع التغيير نفسه يقع في الثانية ذاتها فيُقبل.
 */
export function issuedBeforePasswordChange(iat: number | undefined, changedAt: Date | null): boolean {
  if (!changedAt) return false;
  if (!iat) return true;
  return iat < Math.floor(changedAt.getTime() / 1000);
}

/** أقلّ دور مطلوب للمسار. */
export const ROLE_KEY = 'azm:minRole';
export const RequireRole = (role: UserRole) => SetMetadata(ROLE_KEY, role);

/**
 * مسار إدارة منصة — يتحقّق من `isPlatformStaff` بدل عضوية شركة.
 *
 * **لا يُجمَع مع مسارات مستأجر في نفس المتحكّم أبدًا.** الفصل على
 * مستوى الوحدة (`modules/platform-admin/`) لا مستوى المسار وحده، كي
 * لا يُصبح خلط الاثنين في ملف واحد ممكنًا أصلًا — انظر توثيق
 * `TenantGuard.canActivate` لسبب المعالجة المبكرة.
 */
export const PLATFORM_ONLY_KEY = 'azm:platformOnly';
export const PlatformOnly = () => SetMetadata(PLATFORM_ONLY_KEY, true);

/**
 * AZM — حارس المستأجر
 *
 * يحوّل رمزًا موثَّقًا إلى [TenantContext]، ويرفض ما دون ذلك.
 *
 * **الشركة تُقرأ من العضوية في القاعدة، لا من الرمز.** الرمز يحمل
 * `userId` و`companyId` المطلوبة، لكن الدور والصلاحية يُجلبان طازجين
 * من `memberships` في كل طلب. السبب: رمز صالح لساعة يظلّ يحمل دورًا
 * سُحب قبل نصف ساعة. قراءة الدور من الرمز تعني أن سحب الصلاحية لا
 * يسري إلا بعد انتهاء الرمز.
 *
 * هذا استعلام إضافي لكل طلب، وثمنه مقبول: البديل نافذة يبقى فيها
 * موظف مفصول قادرًا على الكتابة.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: TenantPrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();

    const minRole = this.reflector.getAllAndOverride<UserRole>(ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // مسار إدارة منصة: يتوقّف هنا قبل أي افتراض بوجود شركة نشطة —
    // موظف المنصة قد لا يملك عضوية في أي شركة أصلًا، وحتى لو ملك واحدة
    // فهي غير ذات صلة بما سيراه هنا (كل الشركات لا شركة واحدة).
    const isPlatformOnly = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // مفتاح API: طريق مصادقة كامل بديل عن JWT — يُقيَّم كليًا هنا ولا
    // يمرّ إلى مسار `req.user` أدناه. المفاتيح للمستأجرين فقط، فلا
    // تُقبل أبدًا على مسار منصة.
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    if (apiKeyHeader) {
      if (isPlatformOnly) {
        throw new ForbiddenException('مفاتيح API لا تُستخدَم لمسارات إدارة المنصة');
      }
      const ctx = await this.resolveApiKey(apiKeyHeader);
      if (minRole !== undefined && !hasRole(ctx.role, minRole)) {
        throw new ForbiddenException('صلاحية هذا المفتاح لا تكفي لهذا الإجراء');
      }
      req.tenant = ctx;
      return true;
    }

    // `req.user` يضعه JwtStrategy بعد التحقّق من التوقيع
    const payload = req.user as
      | { sub?: string; companyId?: string; iat?: number }
      | undefined;

    if (!payload?.sub) {
      throw new UnauthorizedException('رمز غير صالح');
    }

    if (isPlatformOnly) {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, isPlatformStaff: true, platformRole: true, passwordChangedAt: true },
      });
      if (user && issuedBeforePasswordChange(payload.iat, user.passwordChangedAt)) {
        throw new UnauthorizedException(STALE_SESSION);
      }

      if (!user?.isPlatformStaff) {
        throw new ForbiddenException('هذا المسار مخصّص لفريق منصة RVIOS');
      }

      const ctx: PlatformContext = {
        userId: user.id,
        platformRole: user.platformRole ?? 0,
      };
      req.platform = ctx;
      return true;
    }

    if (!payload.companyId) {
      throw new UnauthorizedException('الرمز لا يحدّد شركة');
    }

    // الدور من القاعدة لا من الرمز — انظر توثيق الصنف
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: payload.sub,
        organizationId: payload.companyId,
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true, role: true, organizationId: true, userId: true,
        user: { select: { passwordChangedAt: true } },
      },
    });

    if (!membership) {
      // لا نكشف ما إذا كانت الشركة موجودة: الرسالة نفسها لعدم العضوية
      // ولعدم وجود الشركة. الفارق بينهما يسرّب وجود شركات.
      throw new ForbiddenException('لا عضوية فعّالة في هذه الشركة');
    }

    // الاستعلام نفسه يحمل وقت تغيير كلمة المرور: رمز سُرق قبل تغييرها يسقط فورًا
    if (issuedBeforePasswordChange(payload.iat, membership.user.passwordChangedAt)) {
      throw new UnauthorizedException(STALE_SESSION);
    }

    if (minRole !== undefined && !hasRole(membership.role, minRole)) {
      throw new ForbiddenException('صلاحيتك لا تكفي لهذا الإجراء');
    }

    const ctx: TenantContext = {
      userId: membership.userId,
      companyId: membership.organizationId,
      role: membership.role,
      membershipId: membership.id,
    };
    req.tenant = ctx;

    return true;
  }

  /**
   * يحوّل مفتاح API خامًا إلى [TenantContext].
   *
   * الدور الفعلي هو الأقل صلاحية بين دور المفتاح المُصدَر ودور صاحبه
   * *الحالي* في العضوية (`Math.max`؛ الأصغر رقميًا أعلى صلاحية) — فإن
   * أُنزلت رتبة صاحب المفتاح بعد إصداره ضعُف المفتاح معه تلقائيًا، وإن
   * أُزيل من الشركة توقّف المفتاح فورًا، دون أي خطوة إضافية لإبطاله.
   */
  private async resolveApiKey(rawKey: string): Promise<TenantContext> {
    const invalid = () => new UnauthorizedException('مفتاح API غير صالح');

    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(rawKey) },
    });
    if (!key || key.revokedAt) throw invalid();

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: key.createdBy,
        organizationId: key.companyId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, role: true },
    });
    if (!membership) throw invalid();

    // لا ننتظر الكتابة: تحديث "آخر استخدام" لا يجوز أن يُبطئ كل طلب.
    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      userId: key.createdBy,
      companyId: key.companyId,
      role: Math.max(key.role, membership.role),
      membershipId: membership.id,
    };
  }
}

/**
 * يحقن [TenantContext] في معاملات المتحكّم.
 *
 * ```ts
 * findAll(@Tenant() ctx: TenantContext) { … }
 * ```
 */
export const Tenant = createParamDecorator(
  (_: unknown, context: ExecutionContext): TenantContext => {
    const req = context.switchToHttp().getRequest();
    const ctx = req.tenant as TenantContext | undefined;
    if (!ctx) {
      // يقع فقط إن نُسي الحارس على المسار — خطأ برمجي لا خطأ مستخدم
      throw new Error(
        'TenantContext غير مُهيَّأ: تأكّد من تفعيل TenantGuard على المسار',
      );
    }
    return ctx;
  },
);

/**
 * يحقن [PlatformContext] في معاملات المتحكّم — يقابل `@Tenant()` لكن
 * لمسارات `@PlatformOnly()` فقط.
 */
export const Platform = createParamDecorator(
  (_: unknown, context: ExecutionContext): PlatformContext => {
    const req = context.switchToHttp().getRequest();
    const ctx = req.platform as PlatformContext | undefined;
    if (!ctx) {
      throw new Error(
        'PlatformContext غير مُهيَّأ: تأكّد من تفعيل @PlatformOnly() على المسار',
      );
    }
    return ctx;
  },
);
