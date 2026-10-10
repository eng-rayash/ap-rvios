import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { PUBLIC_KEY } from './tenant.guard';

/**
 * AZM — التحقّق من الرمز، عامًّا
 *
 * للسبب نفسه الذي جعل [TenantGuard] عامًّا: لو وُضع `@UseGuards` على
 * المسارات فرادى لكان كل مسار جديد بلا مصادقة حتى يتذكّر كاتبه
 * إضافته. الآن المصادقة هي الافتراض، و`@Public()` هو الاستثناء
 * المكتوب.
 *
 * يسبق [TenantGuard] في الترتيب لأنه يملأ `req.user` الذي يقرؤه.
 *
 * مفتاح API (ترويسة `x-api-key`) طريق مصادقة ثانٍ يتجاوز هذا الحارس
 * عمدًا: التحقّق منه يحتاج استعلام قاعدة بيانات (`ApiKey` ثم
 * `Membership`)، ومكانه الطبيعي [TenantGuard] الذي يملأ `req.tenant`
 * مباشرة بلا `req.user` وسيط — تمرير هنا لا يعني قبولًا، فـ`TenantGuard`
 * يرفض أي مفتاح غير صالح بنفس صرامة رفضه لرمز JWT غير صالح.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    if (req.headers['x-api-key']) return true;

    return super.canActivate(context);
  }
}
