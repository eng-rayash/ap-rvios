import { Body, Controller, Get, HttpCode, Ip, Post, UnauthorizedException } from '@nestjs/common';

import { Public, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext } from '../../common/tenant/tenant-context';
import { PublicRateLimit } from '../shop/public/rate-limit';
import { AuthService } from './auth.service';
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
  ) {}

  /** عشرة حسابات في الساعة من عنوان واحد — تكفي مكتبًا مشتركًا وتقطع الإنشاء الآلي */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto, @Ip() ip: string) {
    this.limit.check(`register:${ip}`, limitOf('AUTH_REGISTER_LIMIT', 10), 60 * 60_000);
    return this.auth.registerWithCompany(dto);
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

  /** تبديل الشركة النشطة (رمز جديد) — لمن ينتمي لأكثر من شركة. */
  @Post('switch')
  @HttpCode(200)
  switch(@Tenant() ctx: TenantContext, @Body() dto: SwitchCompanyDto) {
    return this.auth.switchCompany(ctx.userId, dto.companyId);
  }
}
