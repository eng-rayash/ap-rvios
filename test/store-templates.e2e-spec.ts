import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * قوالب منصة المتاجر الجديدة: المجانية على الأساسي وحده، والاحترافية تشتري
 * القالب بسعره، والأعمال تأخذ القياسي مجانًا والتوقيع بخصم ٤٠٪. الشراء
 * بفاتورة قالب، ورفع إيصالها يملّك القالب فورًا، ورفضه يسحبه.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('قوالب منصة المتاجر', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'tpl-pass-12345',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
    userId: '',
  });
  const m = mk('merchant');
  const staff = mk('staff');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const KEYS = ['price.plus', 'price.pro', 'billing.currency', 'billing.yearlyMonthsFree', 'tpl.noir'];
  let saved: Array<{ key: string; value: unknown }> = [];
  let storeId = '';
  let slug = '';

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http).post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    u.userId = r.body.user.id;
  }

  /** يرفع الباقة مباشرة من الإدارة — اختبار القوالب لا اختبار الفوترة */
  async function setPlan(plan: 1 | 2) {
    await request(http).get(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).expect(200);
    const list = await request(http).get('/api/v1/platform/store-subscriptions').set(auth(staff.token)).expect(200);
    const sub = list.body.subscriptions.find((s: { storeRef: string }) => s.storeRef === storeId);
    await request(http).patch(`/api/v1/platform/store-subscriptions/${sub.id}`).set(auth(staff.token))
      .send({ plan, status: 0, extendDays: 30 }).expect(200);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    saved = await prisma.platformSetting.findMany({ where: { key: { in: KEYS } } });
    await prisma.platformSetting.deleteMany({ where: { key: { in: KEYS } } });

    await register(m);
    await register(staff);
    await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true, platformRole: 2 } });
    await request(http).patch('/api/v1/platform/settings').set(auth(staff.token))
      .send({ values: { 'price.plus': 6, 'price.pro': 15 } }).expect(200);

    slug = `tpl-${randomUUID().slice(0, 6)}`;
    const st = await request(http).post('/api/v1/shop/stores').set(auth(m.token))
      .send({ name: 'متجر القوالب', slug, whatsapp: '777123456', country: 'YE' }).expect(201);
    storeId = st.body.store.id;
  });

  afterAll(async () => {
    await prisma.platformSetting.deleteMany({ where: { key: { in: KEYS } } }).catch(() => undefined);
    for (const s of saved) await prisma.platformSetting.create({ data: { key: s.key, value: s.value as never } }).catch(() => undefined);
    for (const u of [m, staff]) {
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('الأسعار العامة: الباقات بأسماء المنصة الجديدة، والقوالب بأسعارها، بالدولار', async () => {
    const r = await request(http).get('/api/v1/shop/public/pricing').expect(200);
    expect(r.body.currency).toBe('USD');
    expect(r.body.plans.pro).toEqual({ month: 6, year: 60 }); // شهران مجانًا سنويًا
    expect(r.body.plans.biz).toEqual({ month: 15, year: 150 });
    const noir = r.body.templates.find((t: { id: string }) => t.id === 'noir');
    expect(noir).toEqual({ id: 'noir', tier: 'signature', price: 49 });
    expect(r.body.templates.find((t: { id: string }) => t.id === 'essential').price).toBe(0);
    expect(r.body.templates).toHaveLength(18);
  });

  it('فحص الرابط عام قبل إنشاء الحساب', async () => {
    const taken = await request(http).get(`/api/v1/shop/storefront/slug/check?q=${slug}`).expect(200);
    expect(taken.body.ok).toBe(false);
    const free = await request(http).get(`/api/v1/shop/storefront/slug/check?q=free-${randomUUID().slice(0, 6)}`).expect(200);
    expect(free.body.ok).toBe(true);
  });

  it('المجانية: الأساسي وحده — لا اختيار ولا شراء لقالب مدفوع', async () => {
    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.store.template).toBe('essential');
    expect(c.body.store.planTier).toBe('free');
    const p = await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ template: 'noir' }).expect(409);
    expect(JSON.stringify(p.body)).toContain('PLAN_REQUIRED');
    const i = await request(http).post('/api/v1/shop/invoices').set(auth(m.token))
      .send({ storeRef: storeId, kind: 4, template: 'noir' }).expect(409);
    expect(JSON.stringify(i.body)).toContain('PLAN_REQUIRED');
  });

  let invoiceId = '';
  it('الاحترافية: القالب يُشترى بسعره، ورفع الإيصال يملّكه ويجعله قالب المتجر فورًا', async () => {
    await setPlan(1);
    const p = await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ template: 'noir' }).expect(409);
    expect(JSON.stringify(p.body)).toContain('TEMPLATE_NOT_OWNED');

    const inv = await request(http).post('/api/v1/shop/invoices').set(auth(m.token))
      .send({ storeRef: storeId, kind: 4, template: 'noir' }).expect(201);
    expect(Number(inv.body.amount)).toBe(49);
    expect(inv.body.currency).toBe('USD');
    expect(inv.body.item).toBe('noir');
    invoiceId = inv.body.id;

    await request(http).post(`/api/v1/shop/invoices/${invoiceId}/proof`).set(auth(m.token))
      .send({ method: 'jaib', proofKey: 'https://pub.r2.dev/stores/x/proofs/r.webp' }).expect(201);

    const s = await request(http).get(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).expect(200);
    expect(s.body.store.template).toBe('noir');
    expect(s.body.store.ownedTemplates).toContain('noir');
    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.store.template).toBe('noir');
    expect(c.body.store.planTier).toBe('pro');

    // المملوك يُبدَّل إليه وعنه بلا دفع جديد، وشراؤه مرة ثانية مرفوض
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ template: 'essential' }).expect(200);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ template: 'noir' }).expect(200);
    const again = await request(http).post('/api/v1/shop/invoices').set(auth(m.token))
      .send({ storeRef: storeId, kind: 4, template: 'noir' }).expect(409);
    expect(JSON.stringify(again.body)).toContain('TEMPLATE_OWNED');
  });

  it('رفض الإيصال يسحب القالب ويعيد المتجر إلى الأساسي', async () => {
    await request(http).patch(`/api/v1/platform/invoices/${invoiceId}/review`).set(auth(staff.token))
      .send({ decision: 'rejected', reason: 'إيصال غير مطابق' }).expect(200);
    const s = await request(http).get(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).expect(200);
    expect(s.body.store.ownedTemplates).not.toContain('noir');
    expect(s.body.store.template).toBe('essential');
  });

  it('الأعمال: القياسي مجانًا بلا شراء، والتوقيع بخصم ٤٠٪، وسعر الإدارة يعلو الافتراضي', async () => {
    await setPlan(2);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ template: 'bayt' }).expect(200);
    const free = await request(http).post('/api/v1/shop/invoices').set(auth(m.token))
      .send({ storeRef: storeId, kind: 4, template: 'bayt' }).expect(409);
    expect(JSON.stringify(free.body)).toContain('TEMPLATE_FREE');

    await request(http).patch('/api/v1/platform/settings').set(auth(staff.token)).send({ values: { 'tpl.noir': 50 } }).expect(200);
    const inv = await request(http).post('/api/v1/shop/invoices').set(auth(m.token))
      .send({ storeRef: storeId, kind: 4, template: 'noir' }).expect(201);
    expect(Number(inv.body.amount)).toBe(30); // ٥٠ × ٦٠٪
  });

  it('النطاق الخاص: للمدفوعة وحدها، يُوحَّد، فريد، ويحلّه الـmiddleware إلى رابط المتجر', async () => {
    const domain = `shop-${randomUUID().slice(0, 6)}.example.com`;
    // الباقة الآن «الأعمال» (من الاختبار السابق)
    const r = await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token))
      .send({ customDomain: `https://WWW.${domain.toUpperCase()}/ar` }).expect(200);
    expect(r.body.store.customDomain).toBe(domain);

    const res = await request(http).get(`/api/v1/shop/storefront/domain/resolve?host=${domain}:443`).expect(200);
    expect(res.body.slug).toBe(slug);
    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.store.customDomain).toBe(domain);

    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ customDomain: 'not a domain' }).expect(400);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ customDomain: 'x.rvios.store' }).expect(400);

    // متجر آخر لا يأخذ النطاق نفسه
    const other = await request(http).post('/api/v1/auth/register')
      .send({ email: `o-${randomUUID()}@azm.test`, password: 'other-pass-123', displayName: 'تاجر آخر', companyName: 'شركة أخرى' }).expect(201);
    const os = await request(http).post('/api/v1/shop/stores').set(auth(other.body.accessToken))
      .send({ name: 'متجر آخر', slug: `o-${randomUUID().slice(0, 6)}`, whatsapp: '777123456', country: 'YE' }).expect(201);
    const sub = (await request(http).get('/api/v1/platform/store-subscriptions').set(auth(staff.token)).expect(200))
      .body.subscriptions.find((x: { storeRef: string }) => x.storeRef === os.body.store.id);
    if (sub) await request(http).patch(`/api/v1/platform/store-subscriptions/${sub.id}`).set(auth(staff.token)).send({ plan: 1, status: 0, extendDays: 30 }).expect(200);
    else {
      await request(http).get(`/api/v1/shop/stores/${os.body.store.id}`).set(auth(other.body.accessToken)).expect(200);
      const s2 = (await request(http).get('/api/v1/platform/store-subscriptions').set(auth(staff.token)).expect(200))
        .body.subscriptions.find((x: { storeRef: string }) => x.storeRef === os.body.store.id);
      await request(http).patch(`/api/v1/platform/store-subscriptions/${s2.id}`).set(auth(staff.token)).send({ plan: 1, status: 0, extendDays: 30 }).expect(200);
    }
    await request(http).patch(`/api/v1/shop/stores/${os.body.store.id}`).set(auth(other.body.accessToken)).send({ customDomain: domain }).expect(409);
    await prisma.organization.delete({ where: { id: other.body.company.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: other.body.user.id } }).catch(() => undefined);

    // الإزالة تُوقف الحلّ
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ customDomain: '' }).expect(200);
    await request(http).get(`/api/v1/shop/storefront/domain/resolve?host=${domain}`).expect(404);
  });

  it('قالب غير معروف يُرفض', async () => {
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(m.token)).send({ template: 'nope' }).expect(400);
  });
});
