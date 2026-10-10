import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * تقييمات المنتجات: من مشترٍ فعلي وحده (سطر من طلب مكتمل برقمه)، تقييم واحد
 * لكل سطر، والمتوسّط في الكتالوج من المنشور وحده، وللتاجر الإخفاء والردّ.
 */
describe('تقييمات المنتجات', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const u = { email: `rev-${randomUUID()}@azm.test`, password: 'rev-pass-12345', token: '', companyId: '' };
  const auth = () => ({ Authorization: `Bearer ${u.token}` });
  let storeId = '';
  let slug = '';
  let productId = '';
  let orderId = '';
  let ref = '';
  let itemId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    const r = await request(http).post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: 'rev', companyName: 'شركة التقييم' }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    slug = `rev-${randomUUID().slice(0, 6)}`;
    const st = await request(http).post('/api/v1/shop/stores').set(auth())
      .send({ name: 'متجر التقييم', slug, whatsapp: '777123456', country: 'YE' }).expect(201);
    storeId = st.body.store.id;
    const p = await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth())
      .send({ name: 'بن حرازي', price: 9000, qty: 10 }).expect(201);
    productId = p.body.id;

    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`)
      .send({ lines: [{ id: productId, qty: 1 }], name: 'سالم', phone: '777000111' }).expect(201);
    ref = o.body.ref;
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${ref}`).expect(200);
    itemId = t.body.items[0].id;
    expect(t.body.items[0].reviewed).toBe(false);
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/orders`).set(auth()).expect(200);
    orderId = list.body.orders.find((x: { ref: string }) => x.ref === ref).id;
  });

  afterAll(async () => {
    if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
    await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    await app.close();
  });

  const send = (body: object) => request(http).post(`/api/v1/shop/storefront/${slug}/orders/${ref}/reviews`).send(body);

  it('لا تقييم قبل اكتمال الطلب', async () => {
    const r = await send({ itemId, rating: 5, body: 'ممتاز جدًا' }).expect(409);
    expect(JSON.stringify(r.body)).toContain('ORDER_NOT_DONE');
  });

  it('بعد الاكتمال: يُقبل مرة واحدة لكل سطر، ويظهر في الكتالوج والتتبّع', async () => {
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${orderId}`).set(auth()).send({ status: 1 }).expect(200);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${orderId}`).set(auth()).send({ status: 2 }).expect(200);

    await send({ itemId: randomUUID(), rating: 5, body: 'سطر ليس في الطلب' }).expect(400);
    await send({ itemId, rating: 6, body: 'خارج المدى' }).expect(400);
    const ok = await send({ itemId, rating: 4, body: 'بن طازج ورائحته قوية' }).expect(201);
    expect(ok.body.ok).toBe(true);
    await send({ itemId, rating: 5, body: 'مرة ثانية' }).expect(409);

    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    const prod = c.body.products.find((x: { id: string }) => x.id === productId);
    expect(prod.rating).toBe(4);
    expect(prod.reviewCount).toBe(1);

    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${ref}`).expect(200);
    expect(t.body.items[0].reviewed).toBe(true);

    const pr = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/reviews`).expect(200);
    expect(pr.body).toMatchObject({ average: 4, count: 1 });
    expect(pr.body.reviews[0]).toMatchObject({ rating: 4, name: 'سالم', body: 'بن طازج ورائحته قوية' });
  });

  it('التاجر يردّ ويُخفي — والمخفي يخرج من المتوسّط', async () => {
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/reviews`).set(auth()).expect(200);
    expect(list.body.reviews).toHaveLength(1);
    expect(list.body.average).toBe(4);
    const id = list.body.reviews[0].id;

    await request(http).patch(`/api/v1/shop/stores/${storeId}/reviews/${id}`).set(auth()).send({ reply: 'شكرًا لك!' }).expect(200);
    const pr = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/reviews`).expect(200);
    expect(pr.body.reviews[0].reply).toBe('شكرًا لك!');

    await request(http).patch(`/api/v1/shop/stores/${storeId}/reviews/${id}`).set(auth()).send({ status: 2 }).expect(200);
    const c = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(c.body.products.find((x: { id: string }) => x.id === productId).reviewCount).toBe(0);
    const hidden = await request(http).get(`/api/v1/shop/stores/${storeId}/reviews?status=2`).set(auth()).expect(200);
    expect(hidden.body.reviews).toHaveLength(1);
  });
});
