import { Controller, Get } from '@nestjs/common';

import { Public } from '../../common/tenant/tenant.guard';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * إعدادات تطبيق عزم الجوال — يقرؤها عند الإقلاع قبل الدخول: أدنى إصدار
 * مسموح (وإلا طلب التحديث)، ووضع الصيانة ورسالته، ورابط المتجر. تُضبط من
 * إعدادات المنصة (`PATCH /platform/settings` بمفاتيح `app.*`).
 */
@Public()
@Controller('app')
export class AppConfigController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get('config')
  config() {
    return this.settings.appConfig();
  }
}
