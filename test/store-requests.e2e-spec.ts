import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * طلبات المتاجر المدفوعة (حجز بانتظار الفريق ثم تفعيل أو رفض)، وتجديد صفحة المتجر في منصة
 * المتاجر بعد التعليق والتفعيل، وحسابات فريق المنصة، وحذف المتجر الوحيد بتأكيد.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('طلبات المتاجر وإدارة المنصة', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const mk = (label: string) => ({ email: `${label}-${randomUUID()}@azm.test`, password: 'req-pass-12345', displayName: label, companyName: `شركة ${label}`, token: '', companyId: '', userId: '' });
  const merchant = mk('req-merchant');
  const admin = mk('req-admin');
  const support = mk('req-support');
  const purged: string[] = [];
  const realFetch = global.fetch;
  const KEYS = ['price.plus', 'price.pro'];
  let saved: Array<{ key: string; value: unknown }> = [];

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http).post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    u.userId = r.body.user.id;
  }
  const newStore = (body: object) => request(http).post('/api/v1/shop/stores').set(auth(merchant.token))
    .send({ name: 'متجر الطلب', slug: `req-${randomUUID().slice(0, 8)}`, whatsapp: '777123456', country: 'YE', ...body });

  beforeAll(async () => {
    process.env.STOREFRONT_URL = 'https://store.test';
    process.env.REVALIDATE_SECRET = 'revalidate-secret';
    global.fetch = (async (url: string, init: RequestInit) => {
      if (String(url) === 'https://store.test/api/revalidate') {
        expect((init.headers as Record<string, string>)['x-revalidate-secret']).toBe('revalidate-secret');
        purged.push(JSON.parse(String(init.body)).slug);
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    saved = await prisma.platformSetting.findMany({ where: { key: { in: KEYS } } });
    for (const u of [merchant, admin, support]) await register(u);
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformStaff: true, platformRole: 2 } });
    await prisma.user.update({ where: { id: support.userId }, data: { isPlatformStaff: true, platformRole: 0 } });
    await request(http).patch('/api/v1/platform/settings').set(auth(admin.token)).send({ values: { 'price.plus': 6, 'price.pro': 15 } }).expect(200);
    // متجر أول مجاني، فالطلب التالي يحتاج خانة — والاختبار يشتريها بلا دفع
    await prisma.organization.update({ where: { id: merchant.companyId }, data: { storeSlots: 4 } });
  });

  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.STOREFRONT_URL;
    delete process.env.REVALIDATE_SECRET;
    await prisma.platformSetting.deleteMany({ where: { key: { in: KEYS } } }).catch(() => undefined);
    for (const s of saved) await prisma.platformSetting.create({ data: { key: s.key, value: s.value as never } }).catch(() => undefined);
    for (const u of [merchant, admin, support]) {
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('المجاني يعمل فورًا، والمدفوع يُحجز بانتظار الفريق ولا يراه الزوّار', async () => {
    const free = await newStore({}).expect(201);
    expect(free.body.store.status).toBe(0);

    const r = await newStore({ plan: 'plus', months: 1, template: 'noir' }).expect(201);
    expect(r.body.store.status).toBe(2);
    expect(r.body.store.plan).toBe('basic');
    await request(http).get(`/api/v1/shop/storefront/${r.body.store.slug}/catalogue`).expect(404);

    const list = await request(http).get('/api/v1/platform/shop-stores/requests').set(auth(support.token)).expect(200);
    const row = list.body.find((x: { id: string }) => x.id === r.body.store.id);
    expect(row.owner.email).toBe(merchant.email);
    expect(row.invoices.map((i: { kind: number }) => i.kind).sort()).toEqual([0, 4]);
    expect(row.total).toBe(6 + 49);
    // الطلب لا يُعلَّق ولا يُفعَّل من مسار التعليق
    await request(http).patch(`/api/v1/platform/shop-stores/${r.body.store.id}/status`).set(auth(admin.token)).send({ suspended: false }).expect(400);
  });

  it('التفعيل يسدّد الفواتير فتعمل الباقة والقالب ويظهر المتجر، وتُجدَّد صفحته', async () => {
    const r = await newStore({ plan: 'plus', months: 12, template: 'noir' }).expect(201);
    const { id, slug } = r.body.store;
    purged.length = 0;
    await request(http).post(`/api/v1/platform/shop-stores/${id}/activate`).set(auth(admin.token)).send({ paymentReference: 'TRX-1' }).expect(201);
    expect(purged).toContain(slug);

    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.store.planTier).toBe('pro');
    expect(c.body.store.template).toBe('noir');
    const list = await request(http).get('/api/v1/platform/shop-stores/requests').set(auth(admin.token)).expect(200);
    expect(list.body.find((x: { id: string }) => x.id === id)).toBeUndefined();
    await request(http).post(`/api/v1/platform/shop-stores/${id}/activate`).set(auth(admin.token)).send({}).expect(400);
  });

  it('الرفض يحذف الطلب ويحرر رابطه ويترك الفواتير مرفوضة للسجل', async () => {
    const r = await newStore({ plan: 'pro', months: 1 }).expect(201);
    const { id, slug } = r.body.store;
    await request(http).post(`/api/v1/platform/shop-stores/${id}/reject`).set(auth(admin.token)).send({ reason: 'لم يُستكمل الدفع' }).expect(201);
    expect(await prisma.shopStore.findUnique({ where: { id } })).toBeNull();
    const inv = await prisma.platformInvoice.findMany({ where: { storeRef: id } });
    expect(inv.every((i) => i.status === 3)).toBe(true);
    const check = await request(http).get(`/api/v1/shop/storefront/slug/check?q=${slug}`).expect(200);
    expect(check.body.ok).toBe(true);
  });

  it('التعليق ثم التفعيل يعيد المتجر كما كان ويجدّد صفحته في كل مرة', async () => {
    const r = await newStore({}).expect(201);
    const { id, slug } = r.body.store;
    purged.length = 0;
    await request(http).patch(`/api/v1/platform/shop-stores/${id}/status`).set(auth(admin.token)).send({ suspended: true }).expect(200);
    await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(410);
    await request(http).patch(`/api/v1/platform/shop-stores/${id}/status`).set(auth(admin.token)).send({ suspended: false }).expect(200);
    await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(purged.filter((s) => s === slug).length).toBe(2);
  });

  it('حسابات فريق المنصة: المدير العام وحده يمنح ويسحب، ولا يغيّر صلاحيته بنفسه', async () => {
    const list = await request(http).get(`/api/v1/platform/users?q=${encodeURIComponent(merchant.email)}`).set(auth(support.token)).expect(200);
    expect(list.body[0].email).toBe(merchant.email);
    expect(list.body[0].passwordHash).toBeUndefined();

    await request(http).patch(`/api/v1/platform/users/${merchant.userId}/staff`).set(auth(support.token)).send({ role: 1 }).expect(403);
    await request(http).patch(`/api/v1/platform/users/${admin.userId}/staff`).set(auth(admin.token)).send({ role: null }).expect(400);
    await request(http).patch(`/api/v1/platform/users/${merchant.userId}/staff`).set(auth(admin.token)).send({ role: 1 }).expect(200);
    await request(http).get('/api/v1/platform/shop-stores/requests').set(auth(merchant.token)).expect(200);
    await request(http).patch(`/api/v1/platform/users/${merchant.userId}/staff`).set(auth(admin.token)).send({ role: null }).expect(200);
    await request(http).get('/api/v1/platform/shop-stores/requests').set(auth(merchant.token)).expect(403);
  });

  it('المتجر الوحيد يُحذف بتأكيد رابطه فقط', async () => {
    const solo = mk('req-solo');
    await register(solo);
    try {
      const st = await request(http).post('/api/v1/shop/stores').set(auth(solo.token))
        .send({ name: 'متجر وحيد', slug: `solo-${randomUUID().slice(0, 8)}`, whatsapp: '777123456', country: 'YE' }).expect(201);
      const { id, slug } = st.body.store;
      const no = await request(http).delete(`/api/v1/shop/stores/${id}`).set(auth(solo.token)).expect(409);
      expect(JSON.stringify(no.body)).toContain('LAST_STORE');
      await request(http).delete(`/api/v1/shop/stores/${id}?confirm=wrong`).set(auth(solo.token)).expect(409);
      await request(http).delete(`/api/v1/shop/stores/${id}?confirm=${slug}`).set(auth(solo.token)).expect(200);
      expect(await prisma.shopStore.findUnique({ where: { id } })).toBeNull();
    } finally {
      await prisma.organization.delete({ where: { id: solo.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: solo.email } }).catch(() => undefined);
    }
  });
});
