import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { UserRole } from '../../common/tenant/tenant-context';
import { normalizeArabic } from '../../common/text/normalize-arabic';
import { DEMO_EMAIL, DEMO_SESSION, DEMO_WORKSPACE_SLUG } from '../demo/demo.constant';
import { EmailCodesService } from './email-codes.service';
import { verifyGoogleIdToken } from './google-id-token';

/**
 * AZM — المصادقة
 *
 * القرار الأمني هنا لا في العميل. الرمز يحمل هوية المستخدم والشركة
 * النشطة، والدور يُقرأ من العضوية في كل طلب — لا من الرمز.
 */
@Injectable()
export class AuthService {
  /**
   * كلفة bcrypt.
   *
   * ١٢ جولة: نحو ٢٥٠ مللي ثانية على عتاد الخوادم الحالي. الرفع يزيد
   * كلفة كسر التجزئة أُسّيًا، والخفض تحت ١٠ يجعلها في متناول عتاد
   * استهلاكي.
   */
  private static readonly BCRYPT_ROUNDS = 12;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
    private readonly codes: EmailCodesService,
  ) {}

  /**
   * التسجيل من الواجهات: مع رموز البريد لا جلسة قبل تأكيده. الحساب يبقى إن تعطّل الإرسال —
   * إعادة الإرسال تكمله، وإلا لرفض التسجيلُ التالي بريدًا «مسجَّلًا» لا يستطيع صاحبه دخوله.
   */
  async register(input: { email: string; password: string; displayName: string; companyName: string }) {
    const r = await this.registerWithCompany(input);
    if (!this.codes.enabled) return r;
    const sent = await this.codes.issue(r.user, 'verify');
    return { verificationRequired: true as const, email: r.user.email, sent };
  }

  /** يؤكد رمز البريد ويصدر الجلسة */
  async verifyCode(input: { email: string; code: string; companyId?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      select: { id: true, deletedAt: true },
    });
    await this.codes.consume(user && !user.deletedAt ? user.id : undefined, 'verify', input.code);
    await this.prisma.user.update({ where: { id: user!.id }, data: { emailVerifiedAt: new Date() } });
    return this.signIn(user!.id, false, input.companyId);
  }

  /**
   * ردّ واحد للمسجَّل وغيره، والإرسال لا يُنتظر: زمن الردّ لا يكشف أي البُرد لها حساب.
   */
  forgotPassword(email: string) {
    void (async () => {
      const user = await this.prisma.user.findUnique({
        where: { email: email.trim().toLowerCase() },
        select: { id: true, email: true, deletedAt: true },
      });
      if (user && !user.deletedAt) await this.codes.issue(user, 'reset');
    })().catch(() => undefined);
    return { ok: true };
  }

  /** تغيير كلمة المرور يُبطل كل جلسة سابقة، والرمز يثبت ملكية البريد */
  async resetPassword(input: { email: string; code: string; newPassword: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      select: { id: true, deletedAt: true },
    });
    await this.codes.consume(user && !user.deletedAt ? user.id : undefined, 'reset', input.code);
    await this.prisma.user.update({
      where: { id: user!.id },
      data: {
        passwordHash: await bcrypt.hash(input.newPassword, AuthService.BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });
    return { ok: true };
  }

  /**
   * ينشئ حسابًا وشركةً معًا، ويجعل المُنشئ مالكها.
   *
   * العمليات الثلاث في معاملة واحدة: مستخدم بلا شركة لا يستطيع فعل
   * شيء، وشركة بلا مالك لا يملك أحد إدارتها. نجاح جزئي هنا يترك
   * حسابًا معطوبًا لا سبيل لإصلاحه من الواجهة.
   */
  async registerWithCompany(input: {
    email: string;
    password: string;
    displayName: string;
    companyName: string;
  }) {
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('هذا البريد مسجَّل بالفعل');
    }

    const passwordHash = await bcrypt.hash(
      input.password,
      AuthService.BCRYPT_ROUNDS,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          syncId: randomUUID(),
          email,
          passwordHash,
          displayName: input.displayName.trim(),
        },
      });

      const org = await tx.organization.create({
        data: {
          syncId: randomUUID(),
          companyCode: await this.generateCompanyCode(tx),
          name: input.companyName.trim(),
          workspaceSlug: await this.generateSlug(tx, input.companyName),
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const membership = await tx.membership.create({
        data: {
          syncId: randomUUID(),
          userId: user.id,
          organizationId: org.id,
          role: UserRole.Owner,
          joinedAt: new Date(),
        },
      });

      return { user, org, membership };
    });

    return {
      accessToken: await this.signToken(result.user.id, result.org.id),
      user: this.publicUser(result.user),
      company: this.publicCompany(result.org),
    };
  }

  /**
   * يتحقّق من بيانات الدخول ويصدر رمزًا للشركة المطلوبة.
   *
   * [companyId] اختياري: حين يُترك تُختار أول عضوية فعّالة. مستخدم
   * ينتمي لأكثر من شركة يحدّدها صراحةً.
   */
  async login(input: {
    email: string;
    password: string;
    companyId?: string;
  }) {
    const email = input.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          where: { isActive: true, deletedAt: null },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                companyCode: true,
                workspaceSlug: true,
                trialEndsAt: true,
              },
            },
          },
          orderBy: { role: 'asc' },
        },
      },
    });

    // الرسالة نفسها لبريد غير مسجَّل ولكلمة مرور خاطئة: التفريق
    // بينهما يكشف أي البُرد مسجَّلة في النظام.
    const invalid = new UnauthorizedException(
      'البريد أو كلمة المرور غير صحيحة',
    );

    if (!user || user.deletedAt) {
      // تجزئة وهمية تُوازن الزمن: الخروج المبكر يجعل الردّ على بريد
      // غير مسجَّل أسرع، وهو فارق يُقاس ويُستغلّ لحصر البُرد.
      await bcrypt.compare(input.password, DUMMY_HASH);
      throw invalid;
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) throw invalid;

    if (user.memberships.length === 0) {
      throw new UnauthorizedException('لا عضوية فعّالة لهذا الحساب');
    }

    const membership = input.companyId
      ? user.memberships.find((m) => m.organizationId === input.companyId)
      : user.memberships[0];

    if (!membership) {
      throw new UnauthorizedException('لا عضوية فعّالة في هذه الشركة');
    }

    if (this.codes.enabled) {
      const sent = await this.codes.issue(user, 'verify');
      return { verificationRequired: true as const, email: user.email, sent };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken: await this.signToken(user.id, membership.organizationId),
      user: this.publicUser(user),
      company: membership.organization,
      companies: user.memberships.map((m) => ({
        ...m.organization,
        role: m.role,
      })),
    };
  }

  /**
   * الدخول بحساب Google، ويُنشئ حسابًا وشركة لأول مرة (يكمل بياناته ومتجره من داخل حسابه).
   *
   * بريد مسجَّل بكلمة مرور لا يُربط تلقائيًا: التسجيل بكلمة مرور لا يؤكد البريد، فالربط
   * يترك لمن سجّله أولًا — ولو كان منتحلًا — مدخلًا إلى حساب صاحب البريد الحقيقي.
   */
  async google(credential: string) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new ServiceUnavailableException('الدخول بحساب Google غير مفعّل');
    const g = await verifyGoogleIdToken(credential, clientId);

    const linked = await this.prisma.user.findUnique({ where: { googleSub: g.sub } });
    if (linked && !linked.deletedAt) return this.signIn(linked.id, false);
    if (linked) throw new UnauthorizedException('هذا الحساب محذوف');

    const taken = await this.prisma.user.findUnique({ where: { email: g.email }, select: { id: true } });
    if (taken) {
      throw new ConflictException({
        message: 'هذا البريد مسجَّل بكلمة مرور — سجّل الدخول بها',
        code: 'EMAIL_USES_PASSWORD',
      });
    }

    const r = await this.registerWithCompany({
      email: g.email,
      // لا يُعرف لأحد: الدخول بكلمة مرور يبدأ بـ«نسيت كلمة المرور»
      password: randomUUID() + randomUUID(),
      displayName: g.name.slice(0, 80),
      companyName: g.name.slice(0, 120),
    });
    await this.prisma.user.update({
      where: { id: r.user.id },
      data: { googleSub: g.sub, emailVerifiedAt: new Date(), avatarUrl: g.picture },
    });
    return this.signIn(r.user.id, true);
  }

  private async signIn(userId: string, isNew: boolean, companyId?: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
      include: {
        memberships: {
          where: { isActive: true, deletedAt: null },
          include: { organization: { select: { id: true, name: true, companyCode: true, workspaceSlug: true, trialEndsAt: true } } },
          orderBy: { role: 'asc' },
        },
      },
    });
    const membership = companyId ? user.memberships.find((m) => m.organizationId === companyId) : user.memberships[0];
    if (!membership) throw new UnauthorizedException('لا عضوية فعّالة لهذا الحساب');
    return {
      accessToken: await this.signToken(user.id, membership.organizationId),
      user: this.publicUser(user),
      company: membership.organization,
      companies: user.memberships.map((m) => ({ ...m.organization, role: m.role })),
      isNew,
    };
  }

  /**
   * دخول العرض التجريبي — بلا كلمة مرور، لشركة العرض وحدها، بجلسة قصيرة. الشركة
   * للقراءة فقط (الحارس يرفض الكتابة)، فالدخول المفتوح لا يعرّض شيئًا.
   */
  async demo() {
    const membership = await this.prisma.membership.findFirst({
      where: {
        user: { email: DEMO_EMAIL },
        organization: { workspaceSlug: DEMO_WORKSPACE_SLUG },
        isActive: true,
        deletedAt: null,
      },
      include: {
        user: true,
        organization: { select: { id: true, name: true, companyCode: true, workspaceSlug: true, trialEndsAt: true } },
      },
    });
    if (!membership) throw new NotFoundException('العرض التجريبي غير مهيّأ بعد');
    const company = membership.organization;
    return {
      accessToken: await this.jwt.signAsync({ sub: membership.userId, companyId: company.id }, { expiresIn: DEMO_SESSION }),
      user: this.publicUser(membership.user),
      company,
      companies: [{ ...company, role: membership.role }],
    };
  }

  /**
   * ينقل المستخدم إلى شركة أخرى ينتمي إليها — رمز جديد دون كلمة مرور،
   * لأن الجلسة الحالية مصادَقة أصلًا. العضوية تُفحص من القاعدة.
   */
  async switchCompany(userId: string, companyId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, organizationId: companyId, isActive: true, deletedAt: null },
      include: { organization: { select: { id: true, name: true } } },
    });
    if (!membership) {
      throw new UnauthorizedException('لا عضوية فعّالة في هذه الشركة');
    }
    return {
      accessToken: await this.signToken(userId, companyId),
      company: membership.organization,
    };
  }

  // ─────────────────────────────────────────────
  // داخلي
  // ─────────────────────────────────────────────

  private signToken(userId: string, companyId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId, companyId });
  }

  /**
   * حقول الشركة التي يحتاجها العميل.
   *
   * `companyCode` و`workspaceSlug` ليسا تفصيلًا داخليًا: الكود هو ما
   * يعطيه المالك لمن يدعوه، والـslug عنوان مساحة العمل. حجبهما كان
   * يجبر العميل على توليد نظيرَين محليًا — فيعرض للمستخدم كودًا لا
   * يعرفه الخادم، ولا ينضمّ به أحد.
   */
  private publicCompany(o: {
    id: string;
    name: string;
    companyCode: string;
    workspaceSlug: string;
    trialEndsAt: Date | null;
  }) {
    return {
      id: o.id,
      name: o.name,
      companyCode: o.companyCode,
      workspaceSlug: o.workspaceSlug,
      trialEndsAt: o.trialEndsAt,
    };
  }

  /** الحقول الآمنة للإرسال — لا تجزئة كلمة المرور ولا حقول داخلية. */
  private publicUser(u: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  }) {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
    };
  }

  /** كود شركة بصيغة `CMP-XXXXXX`، يُعاد توليده عند التصادم. */
  private async generateCompanyCode(tx: {
    organization: { findUnique: Function };
  }): Promise<string> {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا I O 0 1
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = 'CMP-';
      for (let i = 0; i < 6; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const clash = await tx.organization.findUnique({
        where: { companyCode: code },
        select: { id: true },
      });
      if (!clash) return code;
    }
    throw new ConflictException('تعذّر توليد كود شركة فريد');
  }

  /** عنوان مساحة عمل من اسم الشركة، بتحويل صوتي للعربية. */
  private async generateSlug(
    tx: { organization: { findUnique: Function } },
    companyName: string,
  ): Promise<string> {
    const base =
      normalizeArabic(companyName)
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';

    for (let attempt = 0; attempt < 20; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const clash = await tx.organization.findUnique({
        where: { workspaceSlug: slug },
        select: { id: true },
      });
      if (!clash) return slug;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}

/**
 * تجزئة ثابتة لموازنة زمن الردّ عند بريد غير مسجَّل.
 *
 * قيمتها لا تطابق أي كلمة مرور — الغرض استهلاك الزمن نفسه الذي
 * يستهلكه تحقّق حقيقي.
 */
const DUMMY_HASH =
  '$2b$12$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';
