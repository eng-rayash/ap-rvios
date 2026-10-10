import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * حدود الدخول والتسجيل
 *
 * يثبت: الإخفاقات وحدها تُحسب، وبعد الحدّ يُوقَف الحساب حتى بكلمة المرور
 * الصحيحة (فلا يكتشف المخمِّن أنه أصاب)، والنجاح قبل الحدّ يصفّر العدّاد،
 * وتسجيل الحسابات محدود لكل عنوان.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('حدود الدخول والتسجيل', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const users: string[] = [];
  const companies: string[] = [];

  const register = async (expectStatus = 201) => {
    const email = `limits-${randomUUID()}@azm.test`;
    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'limits-pass-1', displayName: 'حدود', companyName: 'شركة الحدود' })
      .expect(expectStatus);
    if (r.status === 201) {
      users.push(email);
      companies.push(r.body.company.id);
    }
    return email;
  };
  const login = (email: string, password: string) => request(http).post('/api/v1/auth/login').send({ email, password });

  beforeAll(async () => {
    process.env.AUTH_LOGIN_ACCOUNT_LIMIT = '3';
    process.env.AUTH_LOGIN_IP_LIMIT = '1000';
    process.env.AUTH_REGISTER_LIMIT = '100000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
  });

  afterAll(async () => {
    delete process.env.AUTH_LOGIN_ACCOUNT_LIMIT;
    delete process.env.AUTH_LOGIN_IP_LIMIT;
    delete process.env.AUTH_REGISTER_LIMIT;
    for (const email of users) await prisma.user.delete({ where: { email } }).catch(() => undefined);
    for (const id of companies) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    await app.close();
  });

  it('بعد ٣ إخفاقات يُوقَف الحساب — حتى بكلمة المرور الصحيحة', async () => {
    const email = await register();
    for (let i = 0; i < 3; i++) await login(email, 'wrong-password').expect(401);
    const r = await login(email, 'limits-pass-1').expect(429);
    expect(r.body.message).toContain('دقيقة');
    // الحساب الآخر لا يتأثّر
    const other = await register();
    await login(other, 'limits-pass-1').expect(200);
  });

  it('الدخول الناجح يصفّر عدّاد الإخفاقات', async () => {
    const email = await register();
    await login(email, 'wrong-password').expect(401);
    await login(email, 'wrong-password').expect(401);
    await login(email, 'limits-pass-1').expect(200);
    await login(email, 'wrong-password').expect(401);
    await login(email, 'wrong-password').expect(401);
    await login(email, 'limits-pass-1').expect(200);
  });

  it('حالة الأحرف والمسافات في البريد لا تفتح عدّادًا جديدًا', async () => {
    const email = await register();
    await login(email, 'wrong-password').expect(401);
    await login(email.toUpperCase(), 'wrong-password').expect(401);
    await login(` ${email} `, 'wrong-password').expect((r) => expect([400, 401]).toContain(r.status));
    await login(email, 'wrong-password').expect((r) => expect([401, 429]).toContain(r.status));
    await login(email, 'limits-pass-1').expect(429);
  });

  it('التسجيل محدود لكل عنوان', async () => {
    process.env.AUTH_REGISTER_LIMIT = '2';
    // العدّاد نفسه قد حُسبت عليه تسجيلات الاختبارات السابقة — فالتالي يُرفض
    await register(429);
    process.env.AUTH_REGISTER_LIMIT = '100000';
  });
});
