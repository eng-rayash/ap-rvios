import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/** حمولة الرمز — هوية فقط، لا صلاحيات. */
export interface JwtPayload {
  /** معرّف المستخدم */
  sub: string;
  /** الشركة النشطة في هذه الجلسة */
  companyId: string;
  /** وقت الإصدار بالثواني (يضعه jsonwebtoken) — يقارنه الحارس بتغيير كلمة المرور */
  iat?: number;
}

/**
 * AZM — التحقّق من الرمز
 *
 * يتحقّق من التوقيع ويستخرج الهوية. **لا يقرّر صلاحية**: ذلك عمل
 * `TenantGuard` الذي يقرأ الدور من القاعدة في كل طلب.
 *
 * الفصل مقصود: الرمز يقول «من أنا وأي شركة أعمل فيها الآن»، والقاعدة
 * تقول «ماذا يحقّ لي». رمز صالح لأسبوع لا يجوز أن يحمل دورًا سُحب.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret || secret === 'change-me-in-production') {
      // فشل عند الإقلاع لا عند أول طلب: خادم يعمل بسرّ افتراضي
      // يوقّع رموزًا يستطيع أي قارئ للمستودع تزويرها.
      throw new Error(
        'JWT_SECRET غير مضبوط أو ما زال على القيمة الافتراضية — ' +
          'ولّد سرًّا حقيقيًا قبل التشغيل',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * ما يعيده يوضع في `req.user`.
   *
   * لا استعلام هنا: التحقّق من العضوية في `TenantGuard`، وإبقاؤه
   * هناك يجعل مسارًا بلا حارس يفشل صراحةً بدل أن يمرّ بصلاحية ضمنية.
   */
  validate(payload: JwtPayload): JwtPayload {
    if (!payload?.sub || !payload?.companyId) {
      throw new UnauthorizedException('رمز ناقص الحمولة');
    }
    return { sub: payload.sub, companyId: payload.companyId, iat: payload.iat };
  }
}
