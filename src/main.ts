import { RequestMethod, ValidationPipe } from '@nestjs/common';
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

  // ترويسات أمان لكل رد. الخادم JSON وصور فقط: لا شيء فيه يُعرض صفحةً أو
  // يُضمَّن في إطار، فالسياسة الأضيق ممكنة. `cross-origin` لأن الواجهات وصور
  // الملفات تُطلب من أصول أخرى أصلًا.
  app.disable('x-powered-by');
  const prod = process.env.NODE_ENV === 'production';
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (prod) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  });

  // الجذر خارج البادئة لفحوص المستضيف الافتراضية — انظر RootController
  app.setGlobalPrefix('api/v1', { exclude: [{ path: '/', method: RequestMethod.GET }] });
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

  // العرض التجريبي (صفحة «جرّب العرض» في AzmSmart): يُبنى تلقائيًا إن غاب أو قدُم، في
  // الخلفية بعد أن يبدأ الخادم بالرد — فلا خطوة يدوية بعد النشر. الاختبارات تتولّاه بنفسها.
  if (process.env.DEMO_AUTOSEED !== '0' && process.env.NODE_ENV !== 'test') {
    void (async () => {
      try {
        const { demoNeedsSeed, seedDemo } = await import('../scripts/seed-demo');
        if (await demoNeedsSeed()) {
          console.log('[demo] بناء شركة العرض التجريبي…');
          await seedDemo();
        }
      } catch (err) {
        console.error('[demo] تعذّر بناء العرض:', err instanceof Error ? err.message : err);
      }
    })();
  }
}

void bootstrap();
