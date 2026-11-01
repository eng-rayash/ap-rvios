import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * رموز البريد: لا جلسة قبل الرمز، عند التسجيل والدخول، ونسيت كلمة المرور.
 * Resend مستبدَل: تُلتقط الرسالة منه، فالمختبَر هو سلوك الخادم لا شبكة البريد.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('رموز التحقق بالبريد', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const sent: { to: string; subject: string; text: string; from: string; reply_to?: string }[] = [];
  let resendUp = true;
  const realFetch = global.fetch;
  const u = () => ({ email: `otp-${randomUUID()}@azm.test`, password: 'otp-pass-12345', displayName: 'تاجر', companyName: 'شركة الرموز' });
  const lastCode = (to: string) => [...sent].reverse().find((m) => m.to === to)!.text.match(/\b\d{6}\b/)![0];
  const emails: string[] = [];
  const post = (path: string, body: object) => request(http).post(`/api/v1/auth/${path}`).send(body);

  /** المهلة بين رسالتين تمنع رمزًا جديدًا فورًا — الاختبار يرجّع وقت الإرسال */
  const expireCooldown = (email: string) =>
    prisma.emailCode.updateMany({ where: { user: { email } }, data: { sentAt: new Date(Date.now() - 2 * 60_000) } });

  async function registered() {
    const a = u();
    emails.push(a.email);
    const r = await post('register', a).expect(201);
    return { a, r };
  }

  beforeAll(async () => {
    process.env.EMAIL_OTP_ENABLED = '1';
    process.env.RESEND_API_KEY = 'test-key';
    process.env.EMAIL_FROM = 'RVIOS <no-reply@rvios.test>';
    process.env.EMAIL_REPLY_TO = 'team@rvios.test';
    global.fetch = (async (_url: string, init: RequestInit) => {
      if (!resendUp) return new Response('{"message":"down"}', { status: 500 });
      const b = JSON.parse(String(init.body));
      sent.push({ to: b.to[0], subject: b.subject, text: b.text, from: b.from, reply_to: b.reply_to });
      return new Response('{"id":"x"}', { status: 200 });
    }) as typeof fetch;

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
    global.fetch = realFetch;
    for (const k of ['EMAIL_OTP_ENABLED', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO']) delete process.env[k];
    for (const email of emails) {
      const user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
      for (const m of user?.memberships ?? []) await prisma.organization.delete({ where: { id: m.organizationId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('التسجيل لا يعطي جلسة قبل الرمز، والرمز يعطيها ويؤكد البريد', async () => {
    const { a, r } = await registered();
    expect(r.body.accessToken).toBeUndefined();
    expect(r.body.verificationRequired).toBe(true);
    const mail = sent.find((m) => m.to === a.email)!;
    expect(mail.from).toContain('no-reply@rvios.test');
    expect(mail.reply_to).toBe('team@rvios.test');

    const row = await prisma.emailCode.findFirst({ where: { user: { email: a.email } } });
    expect(row!.codeHash).not.toContain(lastCode(a.email)); // لا يُخزَّن الرمز نفسه

    const ok = await post('verify', { email: a.email, code: lastCode(a.email) }).expect(200);
    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200);
    const user = await prisma.user.findUnique({ where: { email: a.email } });
    expect(user!.emailVerifiedAt).not.toBeNull();

    // الرمز للاستعمال مرة واحدة
    await post('verify', { email: a.email, code: lastCode(a.email) }).expect(400);
  });

  it('الدخول يرسل رمزًا بعد كلمة المرور الصحيحة وحدها، ولا جلسة قبله', async () => {
    const { a } = await registered();
    const before = sent.length;
    await post('login', { email: a.email, password: 'wrong-password' }).expect(401);
    expect(sent.length).toBe(before);

    await expireCooldown(a.email);
    const r = await post('login', { email: a.email, password: a.password }).expect(200);
    expect(r.body.accessToken).toBeUndefined();
    expect(r.body.verificationRequired).toBe(true);
    expect(sent.length).toBe(before + 1);
    const ok = await post('verify', { email: a.email, code: lastCode(a.email) }).expect(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.companies.length).toBe(1);
  });

  it('خمس محاولات خاطئة تحرق الرمز ولو جاء الصحيح بعدها', async () => {
    const { a } = await registered();
    const good = lastCode(a.email);
    const bad = good === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) await post('verify', { email: a.email, code: bad }).expect(400);
    await post('verify', { email: a.email, code: good }).expect(400);
  });

  it('الرمز المنتهي مرفوض، وبريد غير مسجَّل يُرَدّ عليه بالرسالة نفسها', async () => {
    const { a } = await registered();
    const code = lastCode(a.email);
    await prisma.emailCode.updateMany({ where: { user: { email: a.email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await post('verify', { email: a.email, code }).expect(400);
    const unknown = await post('verify', { email: `nobody-${randomUUID()}@azm.test`, code }).expect(400);
    expect(unknown.body.message).toBe(expired.body.message);
  });

  it('إعادة الإرسال: بمهلة، ولا ترسل لمن لم يثبت كلمة مروره', async () => {
    const { a } = await registered();
    let count = sent.filter((m) => m.to === a.email).length;
    await post('verify/resend', { email: a.email }).expect(200);
    expect(sent.filter((m) => m.to === a.email).length).toBe(count); // داخل المهلة

    await expireCooldown(a.email);
    await post('verify/resend', { email: a.email }).expect(200);
    expect(sent.filter((m) => m.to === a.email).length).toBe(++count);

    // بعد نافذة الدخول الحديث لا يُرسل شيء: البريد ليس بابًا لإغراق صاحبه
    await prisma.emailCode.updateMany({ where: { user: { email: a.email } }, data: { sentAt: new Date(Date.now() - 60 * 60_000) } });
    await post('verify/resend', { email: a.email }).expect(200);
    expect(sent.filter((m) => m.to === a.email).length).toBe(count);
  });

  it('تعطّل البريد لا يكسر التسجيل، وإعادة الإرسال تكمله', async () => {
    resendUp = false;
    const { a, r } = await registered();
    resendUp = true;
    expect(r.body.verificationRequired).toBe(true);
    expect(r.body.sent).toBe(false);
    await expireCooldown(a.email);
    await post('verify/resend', { email: a.email }).expect(200);
    await post('verify', { email: a.email, code: lastCode(a.email) }).expect(200);
  });

  it('نسيت كلمة المرور: ردّ واحد للمسجَّل وغيره، والرمز يغيّرها ويبطل الجلسات القديمة', async () => {
    const { a } = await registered();
    const session = await post('verify', { email: a.email, code: lastCode(a.email) }).expect(200);

    const unknown = await post('password/forgot', { email: `nobody-${randomUUID()}@azm.test` }).expect(200);
    const known = await post('password/forgot', { email: a.email }).expect(200);
    expect(known.body).toEqual(unknown.body);
    await new Promise((r) => setTimeout(r, 100)); // الإرسال لا يُنتظر، كي لا يكشف زمنُ الردّ وجود الحساب

    await new Promise((r) => setTimeout(r, 1100)); // `iat` بالثواني
    const newPassword = 'new-pass-67890';
    await post('password/reset', { email: a.email, code: '000000', newPassword }).expect(400);
    await post('password/reset', { email: a.email, code: lastCode(a.email), newPassword }).expect(200);

    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${session.body.accessToken}`).expect(401);
    await post('login', { email: a.email, password: a.password }).expect(401);
    const again = await post('login', { email: a.email, password: newPassword }).expect(200);
    expect(again.body.verificationRequired).toBe(true);
  });
});
