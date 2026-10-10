import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { assertEnv, originMatcher } from './config/env';
import { DomainErrorFilter } from './common/errors/domain-error.filter';

/**
 * AZM — إقلاع الخادم
 *
 * `whitelist` و`forbidNonWhitelisted` ليسا تجميلًا: بدونهما يستطيع
 * العميل إرسال `companyId` في جسم الطلب فيصل إلى Prisma ويتجاوز
 * الحقن. مع التصفية، أي حقل غير معلَن في الـDTO يُرفض الطلب بسببه
 * صراحةً — والحقول الحسّاسة غير معلَنة في أي DTO أصلًا.
 */
async function bootstrap() {
  assertEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  // خلف موازن حمل/CDN: بدون هذا يرى `@Ip()` عنوان الموازن، فيتشارك كل
  // الزوّار حدًّا واحدًا لطلبات المتجر ونموذج التواصل. القيمة عدد القفزات
  // الموثوقة (١ افتراضيًا في الإنتاج)، و0 يعطّله.
  const hops = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : '0');
  if (hops !== '0') app.set('trust proxy', /^\d+$/.test(hops) ? Number(hops) : hops === 'true');

  // الواجهات أصول مختلفة — بلا هذا يُرفض كل طلب من المتصفح قبل وصوله إلى
  // أي حارس. القائمة من البيئة (مع `https://*.rvios.store` للنطاقات
  // الفرعية) فلا يتسرّب أصل تطوير إلى إعداد إنتاج نُسخ منه بإهمال.
  // واجهة المتجر العامة مستثناة: النطاقات الخاصة للتجّار لا تُحصى، ومساراتها
  // عامة بلا جلسة أصلًا، فلا يحميها حصر الأصول بشيء.
  const allowed = originMatcher(process.env.CORS_ORIGINS ?? 'http://localhost:3001');
  const openPaths = ['/api/v1/shop/storefront/', '/api/v1/health'];
  app.enableCors((req: { url?: string; headers: { origin?: string } }, cb) => {
    const origin = req.headers.origin;
    const open = openPaths.some((p) => (req.url ?? '').startsWith(p));
    cb(null, { origin: !origin ? false : open || allowed(origin) ? origin : false });
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
