import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { cleanPath, deviceOf, sourceOf } from '../src/modules/shop/analytics/visitor-stats';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130';

/** تقرير الزوار: مشاهدات كل صفحة، والجهاز والمصدر للزائر الجديد مرة في يومه، والزواحف لا تُعدّ. */
describe('تقرير الزوار', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const u = { email: `vis-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let productId = '';
  const auth = () => ({ Authorization: `Bearer ${u.token}` });
  const visit = (ip: string, ua: string, body: object) =>
    request(http).post(`/api/v1/shop/storefront/${slug}/visit`).set('X-Forwarded-For', ip).set('User-Agent', ua).send(body).expect(201);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // عناوين الزوار من X-Forwarded-For كما خلف وسيط الإنتاج
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    const r = await request(http).post('/api/v1/auth/register').send({ email: u.email, password: 'vis-pass-12345', displayName: 'تاجر الزوار', companyName: 'شركة الزوار' }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    slug = `vis-${randomUUID().slice(0, 8)}`;
    storeId = (await request(http).post('/api/v1/shop/stores').set(auth()).send({ name: 'متجر الزوار', slug, country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    productId = (await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth()).send({ name: 'عطر العود', price: 9000, qty: 3, live: true }).expect(201)).body.id;
  });

  afterAll(async () => {
    if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
    await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    await app.close();
  });

  it('المساعدات: المسار نظيف بلا أرقام طلبات، والمصدر يُصنَّف، والجهاز من المتصفح', () => {
    expect(cleanPath('/P/abc?utm=1#x')).toBe('/p/abc');
    expect(cleanPath('/order/RS-AB12')).toBe('/order');
    expect(cleanPath('')).toBe('/');
    expect(sourceOf('https://l.facebook.com/l.php?u=x', ['rvios.store'])).toBe('facebook');
    expect(sourceOf('www.google.com.sa', [])).toBe('google');
    expect(sourceOf('shop.rvios.store', ['rvios.store'])).toBe('direct');
    expect(sourceOf('', [])).toBe('direct');
    expect(sourceOf('com.whatsapp', [])).toBe('whatsapp');
    expect(deviceOf(IPHONE)).toBe('mobile');
    expect(deviceOf(DESKTOP)).toBe('desktop');
  });

  it('زائران وثلاث صفحات وزاحف: الأرقام والأبعاد صحيحة، والتقرير للقسم وحده', async () => {
    await visit('10.1.0.1', IPHONE, { path: '/', ref: 'instagram.com' });
    await visit('10.1.0.1', IPHONE, { path: `/p/${productId}`, ref: 'instagram.com' });
    await visit('10.1.0.2', DESKTOP, { path: '/', ref: 'https://www.google.com/' });
    await visit('10.1.0.3', 'Googlebot/2.1 (+http://www.google.com/bot.html)', { path: '/' });
    await request(http).post(`/api/v1/shop/storefront/${slug}/visit`).send({ path: 1 }).expect(400);

    const r = await request(http).get(`/api/v1/shop/stores/${storeId}/analytics/visitors?days=7`).set(auth()).expect(200);
    expect(r.body.totals).toMatchObject({ visitors: 2, views: 3, pagesPerVisit: 1.5 });
    expect(r.body.series).toHaveLength(7);
    expect(r.body.devices).toEqual({ mobile: 1, desktop: 1 });
    expect(r.body.sources.map((s: { source: string }) => s.source).sort()).toEqual(['google', 'instagram']);
    expect(r.body.hours.reduce((a: number, b: number) => a + b, 0)).toBe(2);
    expect(r.body.weekdays.reduce((a: number, b: number) => a + b, 0)).toBe(2);
    expect(r.body.pages[0]).toEqual({ path: '/', views: 2, name: null });
    expect(r.body.pages[1]).toEqual({ path: `/p/${productId}`, views: 1, name: 'عطر العود' });

    // النظرة العامة تقرأ الزوار الفريدين نفسهم
    const o = await request(http).get(`/api/v1/shop/stores/${storeId}/overview`).set(auth()).expect(200);
    expect(JSON.stringify(o.body)).toContain('"visits":2');
  });

  it('التقارير المفصّلة: فترة مخصّصة، والمبيعات تُقارن بالسابقة، والمنتجات والعملاء والقسائم والمخزون', async () => {
    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 2 }], name: 'هند', phone: '777000321' }).expect(201);
    const id = (await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${o.body.ref}`).set(auth()).expect(200)).body.orders[0].id;
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${id}`).set(auth()).send({ status: 1 }).expect(200);
    const today = new Date().toISOString().slice(0, 10);
    const r = await request(http).get(`/api/v1/shop/stores/${storeId}/reports?from=${today}&to=${today}`).set(auth()).expect(200);
    expect(r.body.range).toMatchObject({ from: today, to: today, days: 1 });
    expect(r.body.sales).toMatchObject({ revenue: 18000, orders: 1, averageOrder: 18000, visitors: 2, conversion: 50 });
    expect(r.body.sales.change.revenue).toBeNull();
    expect(r.body.products.top[0]).toMatchObject({ name: 'عطر العود', qty: 2, revenue: 18000 });
    expect(r.body.customers).toMatchObject({ buyers: 1, newBuyers: 1 });
    expect(r.body.orders.byStatus).toEqual({ 1: 1 });
    expect(r.body.inventory).toMatchObject({ products: 1, units: 1 });
    await request(http).get(`/api/v1/shop/stores/${storeId}/reports?from=2026-12-01&to=2026-01-01`).set(auth()).expect(400);
    await request(http).get(`/api/v1/shop/stores/${storeId}/reports?from=2024-01-01&to=2026-01-01`).set(auth()).expect(400);
  });
});
