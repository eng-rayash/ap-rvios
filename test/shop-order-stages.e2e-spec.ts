import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * مراحل الطلب: مؤكد ← قيد التجهيز ← تم الشحن ← مكتمل (المراحل الوسطى اختيارية)،
 * والإلغاء بسبب يراه العميل، ولا رجوع للخلف، والتقييم يُفتح بالاكتمال وحده،
 * والمبيعات تحسب كل ما بعد التأكيد.
 */
describe('مراحل الطلب', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const RUN = randomUUID().slice(0, 8);
  const u = { email: `stages-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let productId = '';

  const auth = () => ({ Authorization: `Bearer ${u.token}` });
  const move = (id: string, body: object) =>
    request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${id}`).set(auth()).send(body);

  async function place() {
    const r = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`)
      .send({ lines: [{ id: productId, qty: 1 }], name: 'عميل', phone: '777000901' }).expect(201);
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${r.body.ref}`).set(auth()).expect(200);
    return { ref: r.body.ref as string, id: list.body.orders[0].id as string };
  }

  beforeAll(async () => {
    process.env.SHOP_ORDER_LIMIT = '1000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    const r = await request(http).post('/api/v1/auth/register')
      .send({ email: u.email, password: 'stages-pass-1234', displayName: 'تاجر', companyName: 'شركة المراحل' }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    slug = `stages-${RUN}`;
    const s = await request(http).post('/api/v1/shop/stores').set(auth()).send({ name: 'متجر المراحل', slug, country: 'YE', whatsapp: '777123456' }).expect(201);
    storeId = s.body.store.id;
    const p = await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth()).send({ name: 'عطر', price: 10000, qty: 50, live: true }).expect(201);
    productId = p.body.id;
  });

  afterAll(async () => {
    if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
    await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    await app.close();
  });

  it('المسار الكامل بالترتيب، ولا رجوع للخلف، والتقييم بعد الاكتمال وحده', async () => {
    const o = await place();
    await move(o.id, { status: 4 }).expect(409); // من «قيد التأكيد» لا تجهيز قبل التأكيد
    await move(o.id, { status: 1 }).expect(200);
    const prep = await move(o.id, { status: 4 }).expect(200);
    expect(prep.body.statusLabel).toBe('قيد التجهيز');

    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.ref}`).expect(200);
    const itemId = t.body.items[0].id;
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders/${o.ref}/reviews`)
      .send({ itemId, rating: 5, body: 'ممتاز جدًا' }).expect(409); // لم يكتمل

    const ship = await move(o.id, { status: 5 }).expect(200);
    expect(ship.body.statusLabel).toBe('تم الشحن');
    await move(o.id, { status: 4 }).expect(409); // لا رجوع من الشحن إلى التجهيز
    await move(o.id, { status: 2 }).expect(200);
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders/${o.ref}/reviews`)
      .send({ itemId, rating: 5, body: 'ممتاز جدًا' }).expect(201);
  });

  it('القفز من «مؤكد» إلى «مكتمل» مسموح لمن لا يحتاج المراحل', async () => {
    const o = await place();
    await move(o.id, { status: 1 }).expect(200);
    await move(o.id, { status: 2 }).expect(200);
  });

  it('الإلغاء من «تم الشحن» يعيد المخزون، وسببه يراه العميل', async () => {
    const before = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth()).expect(200);
    const o = await place();
    await move(o.id, { status: 1 }).expect(200);
    await move(o.id, { status: 5 }).expect(200);
    await move(o.id, { status: 3, reason: '  العميل لم يرد على الاتصال  ' }).expect(200);
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.ref}`).expect(200);
    expect(t.body.status).toBe(3);
    expect(t.body.cancelReason).toBe('العميل لم يرد على الاتصال');
    const after = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth()).expect(200);
    expect(after.body.qty).toBe(before.body.qty);
    await move(o.id, { status: 9 }).expect(400);
  });

  it('المبيعات تحسب الطلب قيد التجهيز والمشحون، والعدّاد يعرف المرحلتين', async () => {
    const o = await place();
    await move(o.id, { status: 1 }).expect(200);
    await move(o.id, { status: 4 }).expect(200);
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/orders`).set(auth()).expect(200);
    expect(list.body.counts['4']).toBe(1);
    expect(list.body.counts['5']).toBe(0);
    const a = await request(http).get(`/api/v1/shop/stores/${storeId}/analytics?days=7`).set(auth()).expect(200);
    // ٣ مبيعات (المكتملان + قيد التجهيز) بسعر ١٠٬٠٠٠ — الملغى لا يُحسب
    expect(JSON.stringify(a.body)).toContain('30000');
  });
});
