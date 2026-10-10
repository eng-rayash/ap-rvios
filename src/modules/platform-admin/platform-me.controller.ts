import { Controller, Get } from '@nestjs/common';

import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';

/**
 * من أنا في فريق المنصة — تستخدمه الواجهة لإظهار/إخفاء قسم الإدارة.
 *
 * إظهار زرّ ليس منعًا، والمنع يقع في `PlatformOnly` على كل مسار فعلي —
 * نفس مبدأ `/auth/me` بالضبط.
 */
@PlatformOnly()
@Controller('platform/me')
export class PlatformMeController {
  @Get()
  me(@Platform() ctx: PlatformContext) {
    return ctx;
  }
}
