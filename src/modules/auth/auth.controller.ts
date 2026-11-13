import { BadRequestException, Body, Controller, Get, HttpCode, Ip, Post, UnauthorizedException } from '@nestjs/common';

import { Public, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext } from '../../common/tenant/tenant-context';
import { PublicRateLimit } from '../shop/public/rate-limit';
import { AuthService } from './auth.service';
import { EmailCodesService } from './email-codes.service';
import { EmailDto, ResetPasswordDto, VerifyCodeDto } from './dto/email-code.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { SwitchCompanyDto } from './dto/switch-company.dto';

/**
 * AZM — مسارات المصادقة
 *
 * مساران عامّان فقط، ومعلَّمان بـ`@Public()` صراحةً. الحارس العامّ
 * يمنع كل ما عداهما افتراضيًا.
 */
/** نافذة حدود الدخول: ١٥ دقيقة */
const LOGIN_WINDOW = 15 * 60_000;
/** في الاختبارات تُسجَّل مئات الحسابات من عنوان واحد — الحدّ يُضبط صراحةً لاختباره */
const limitOf = (name: string, fallback: number) =>
  Number(process.env[name]) || (process.env.NODE_ENV === 'test' ? 100_000 : fallback);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limit: PublicRateLimit,
    private readonly codes: EmailCodesService,
  ) {}

  /** عشرة حسابات في الساعة من عنوان واحد — تكفي مكتبًا مشتركًا وتقطع الإنشاء الآلي */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto, @Ip() ip: string) {
    this.limit.check(`register:${ip}`, limitOf('AUTH_REGISTER_LIMIT', 10), 60 * 60_000);
    return this.auth.register(dto);
  }

  /**
   * ٢٠٠ لا ٢٠١: الدخول لا يُنشئ موردًا.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Ip() ip: string) {
    // الإخفاقات وحدها تُحسب: لكل حساب (تخمين كلمة مرور بعينها، ولو من عناوين
    // كثيرة) ولكل عنوان (تجربة كلمة شائعة على حسابات كثيرة)
    const account = `login:acct:${dto.email.trim().toLowerCase()}`;
    const source = `login:ip:${ip}`;
    this.limit.assertOpen(account, limitOf('AUTH_LOGIN_ACCOUNT_LIMIT', 10));
    this.limit.assertOpen(source, limitOf('AUTH_LOGIN_IP_LIMIT', 30));
    try {
      const r = await this.auth.login(dto);
      this.limit.clear(account);
      return r;
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        this.limit.fail(account, LOGIN_WINDOW);
        this.limit.fail(source, LOGIN_WINDOW);
      }
      throw e;
    }
  }

  /** تأكيد رمز البريد بعد التسجيل أو الدخول — هنا تصدر الجلسة */
  @Public()
  @Post('verify')
  @HttpCode(200)
  async verify(@Body() dto: VerifyCodeDto, @Ip() ip: string) {
    return this.guarded(`verify:ip:${ip}`, () => this.auth.verifyCode(dto));
  }

  @Public()
  @Post('verify/resend')
  @HttpCode(200)
  async resend(@Body() dto: EmailDto, @Ip() ip: string) {
    this.limit.check(`resend:${ip}`, limitOf('AUTH_RESEND_LIMIT', 30), 60 * 60_000);
    await this.codes.resendVerify(dto.email);
    return { ok: true };
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  forgot(@Body() dto: EmailDto, @Ip() ip: string) {
    this.limit.check(`forgot:${ip}`, limitOf('AUTH_FORGOT_LIMIT', 10), 60 * 60_000);
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() dto: ResetPasswordDto, @Ip() ip: string) {
    return this.guarded(`reset:ip:${ip}`, () => this.auth.resetPassword(dto));
  }

  /**
   * تخمين الرموز عبر حسابات كثيرة من عنوان واحد — حدّ الرمز نفسه لا يراه.
   * ثلاثون رمزًا خاطئًا في ربع ساعة تكفي خطأ أي مستخدم حقيقي.
   */
  private async guarded<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.limit.assertOpen(key, limitOf('AUTH_CODE_IP_LIMIT', 30));
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BadRequestException) this.limit.fail(key, LOGIN_WINDOW);
      throw e;
    }
  }

  /** الدخول أو التسجيل بحساب Google — الهوية من رمز توقّعه Google لا من العميل */
  @Public()
  @Post('google')
  @HttpCode(200)
  google(@Body() dto: GoogleLoginDto, @Ip() ip: string) {
    this.limit.check(`google:${ip}`, limitOf('AUTH_GOOGLE_LIMIT', 30), 60 * 60_000);
    return this.auth.google(dto.credential);
  }


  /**
   * من أنا في هذه الشركة.
   *
   * يعيد الدور كما قرأه الحارس من القاعدة لا كما في الرمز. العميل
   * يستخدمه لرسم الواجهة — **لا لحراستها**: إخفاء زرّ ليس منعًا،
   * والمنع يقع هنا في الخادم على كل مسار.
   */
  @Get('me')
  me(@Tenant() ctx: TenantContext) {
    return {
      userId: ctx.userId,
      companyId: ctx.companyId,
      role: ctx.role,
      membershipId: ctx.membershipId,
    };
  }

  /** تجديد رمز الجلسة قبل انتهائه — للتطبيقات عند الفتح (جلسة منزلقة) */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Tenant() ctx: TenantContext) {
    return this.auth.refresh(ctx);
  }

  /** تبديل الشركة النشطة (رمز جديد) — لمن ينتمي لأكثر من شركة. */
  @Post('switch')
  @HttpCode(200)
  switch(@Tenant() ctx: TenantContext, @Body() dto: SwitchCompanyDto) {
    return this.auth.switchCompany(ctx.userId, dto.companyId);
  }
}
