import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * «شكل المتجر» (الحفظ دفعة واحدة وقفل الأسبوع) والدخول بحساب Google. مفاتيح Google
 * في الاختبار زوج محلي — ما يُختبر هو تحقق الخادم من الرمز، لا شبكة Google.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('شكل المتجر والدخول بحساب Google', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const AUD = 'test-client.apps.googleusercontent.com';
  const KID = 'test-key';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

  function idToken(claims: Record<string, unknown>, key = privateKey) {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b64({ alg: 'RS256', kid: KID })}.${b64({
      iss: 'https://accounts.google.com', aud: AUD, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims,
    })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
  }

  const emails: string[] = [];
  const merchant = { email: `look-${randomUUID()}@azm.test`, password: 'look-pass-12345', displayName: 'تاجر', companyName: 'شركة الشكل' };
  const staffUser = { email: `look-staff-${randomUUID()}@azm.test`, password: 'look-pass-12345', displayName: 'موظف', companyName: 'شركة الموظف' };
  let token = '';
  let staffToken = '';
  let storeId = '';
  let slug = '';
  const companies: string[] = [];
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = AUD;
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
    global.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    const r = await request(http).post('/api/v1/auth/register').send(merchant).expect(201);
    token = r.body.accessToken;
    companies.push(r.body.company.id);
    const s = await request(http).post('/api/v1/auth/register').send(staffUser).expect(201);
    staffToken = s.body.accessToken;
    companies.push(s.body.company.id);
    await prisma.user.update({ where: { id: s.body.user.id }, data: { isPlatformStaff: true, platformRole: 2 } });

    slug = `look-${randomUUID().slice(0, 6)}`;
    const st = await request(http).post('/api/v1/shop/stores').set(auth(token))
      .send({ name: 'متجر الشكل', slug, whatsapp: '777123456', country: 'YE' }).expect(201);
    storeId = st.body.store.id;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.GOOGLE_CLIENT_ID;
    for (const id of companies) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    for (const email of [merchant.email, staffUser.email, ...emails]) await prisma.user.delete({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  const url = () => `/api/v1/shop/stores/${storeId}/appearance`;

  it('الحفظ يطبّق النصوص والصور والمنتجات ويظهر في الواجهة العامة، ثم يُقفل أسبوعًا', async () => {
    const seed = await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth(token))
      .send({ name: 'عيّنة', price: 100, qty: 5, live: true }).expect(201);
    const seedId = seed.body.product?.id ?? seed.body.id;

    const r = await request(http).put(url()).set(auth(token)).send({
      name: 'الاسم الجديد',
      logo: 'https://cdn.test/logo.webp',
      banner: 'https://cdn.test/hero.webp',
      copy: { h1: 'عنوان جديد', storyTxt: '  قصتنا  ', unknown: 'يُهمل' },
      hidden: ['sub', 'storyImg', 'unknown'],
      deleteProducts: [seedId],
      products: [{ name: 'عطر', price: 250, oldPrice: 300, image: 'https://cdn.test/p.webp' }],
    }).expect(200);
    expect(new Date(r.body.store.appearanceLockedUntil).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);

    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.store.name).toBe('الاسم الجديد');
    expect(c.body.store.banner).toBe('https://cdn.test/hero.webp');
    expect(c.body.store.appearance).toEqual({ copy: { h1: 'عنوان جديد', storyTxt: 'قصتنا' }, hidden: ['sub', 'storyImg'] });
    expect(c.body.store.appearanceLockedUntil).toBeUndefined();
    expect(c.body.products.map((p: { name: string }) => p.name)).toEqual(['عطر']);
    expect(c.body.products[0].oldPrice).toBe(300);
  });

  it('خلال القفل يُرفض الحفظ، ولا يُفتح إلا بفريق المنصة', async () => {
    const locked = await request(http).put(url()).set(auth(token)).send({ copy: { h1: 'محاولة' } }).expect(409);
    expect(JSON.stringify(locked.body)).toContain('APPEARANCE_LOCKED');
    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.store.appearance.copy.h1).toBe('عنوان جديد');

    await request(http).post(`/api/v1/platform/shop-stores/${storeId}/appearance-unlock`).set(auth(token)).expect(403);
    await request(http).post(`/api/v1/platform/shop-stores/${storeId}/appearance-unlock`).set(auth(staffToken)).expect(201);
    await request(http).put(url()).set(auth(token)).send({ copy: { h1: 'بعد الفتح' } }).expect(200);
  });

  it('متجر بباقة مدفوعة لا يدخل المحرر', async () => {
    const list = await request(http).get('/api/v1/platform/store-subscriptions').set(auth(staffToken)).expect(200);
    const sub = list.body.subscriptions.find((s: { storeRef: string }) => s.storeRef === storeId);
    await request(http).patch(`/api/v1/platform/store-subscriptions/${sub.id}`).set(auth(staffToken))
      .send({ plan: 1, status: 0, extendDays: 30 }).expect(200);
    await request(http).post(`/api/v1/platform/shop-stores/${storeId}/appearance-unlock`).set(auth(staffToken)).expect(201);
    const r = await request(http).put(url()).set(auth(token)).send({ copy: { h1: 'ممنوع' } }).expect(409);
    expect(JSON.stringify(r.body)).toContain('APPEARANCE_UNAVAILABLE');
  });

  describe('Google', () => {
    const google = (credential: string) => request(http).post('/api/v1/auth/google').send({ credential });

    it('أول دخول ينشئ حسابًا وشركة، والثاني يعود إليهما', async () => {
      const email = `g-${randomUUID()}@gmail.test`;
      emails.push(email);
      const sub = randomUUID();
      const first = await google(idToken({ sub, email, name: 'سارة' })).expect(200);
      expect(first.body.isNew).toBe(true);
      expect(first.body.user.email).toBe(email);
      companies.push(first.body.company.id);
      await request(http).get('/api/v1/auth/me').set(auth(first.body.accessToken)).expect(200);

      // الهوية هي `sub`: تغيّر البريد عند Google لا ينشئ حسابًا ثانيًا
      const again = await google(idToken({ sub, email: `new-${email}`, name: 'سارة' })).expect(200);
      expect(again.body.isNew).toBe(false);
      expect(again.body.user.id).toBe(first.body.user.id);
    });

    it('بريد مسجَّل بكلمة مرور لا يُربط تلقائيًا', async () => {
      const r = await google(idToken({ sub: randomUUID(), email: merchant.email, name: 'منتحل' })).expect(409);
      expect(JSON.stringify(r.body)).toContain('EMAIL_USES_PASSWORD');
      const u = await prisma.user.findUnique({ where: { email: merchant.email } });
      expect(u?.googleSub).toBeNull();
    });

    it('يرفض التوقيع الخاطئ والجمهور الآخر والمنتهي والبريد غير المؤكد', async () => {
      const claims = { sub: randomUUID(), email: `x-${randomUUID()}@gmail.test`, name: 'س' };
      await google(idToken(claims, other.privateKey)).expect(401);
      await google(idToken({ ...claims, aud: 'another-app' })).expect(401);
      await google(idToken({ ...claims, iss: 'https://evil.test' })).expect(401);
      await google(idToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 })).expect(401);
      await google(idToken({ ...claims, email_verified: false })).expect(401);
      await google('not-a-token').expect(401);
      expect(await prisma.user.findUnique({ where: { email: claims.email } })).toBeNull();
    });
  });
});
