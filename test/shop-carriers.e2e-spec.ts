import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { trackLink } from '../src/modules/shop/carriers/carriers';

/** شركات الشحن: رقم الشحنة ورابط تتبّعه يظهران للعميل بعد الشحن، ويبقيان لو حُذفت الشركة. */
describe('شركات الشحن ورقم التتبّع', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const u = { email: `car-${randomUUID()}@azm.test`, token: '', companyId: '' };
  const other = { email: `car2-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let productId = '';
  const auth = (t = u.token) => ({ Authorization: `Bearer ${t}` });
  const base = () => `/api/v1/shop/stores/${storeId}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    for (const x of [u, other]) {
      const r = await request(http).post('/api/v1/auth/register').send({ email: x.email, password: 'car-pass-12345', displayName: 'تاجر الشحن', companyName: 'شركة الشحن' }).expect(201);
      x.token = r.body.accessToken;
      x.companyId = r.body.company.id;
    }
    slug = `car-${randomUUID().slice(0, 8)}`;
    storeId = (await request(http).post('/api/v1/shop/stores').set(auth()).send({ name: 'متجر الشحن', slug, country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    productId = (await request(http).post(`${base()}/products`).set(auth()).send({ name: 'حقيبة', price: 5000, qty: 9, live: true }).expect(201)).body.id;
  });

  afterAll(async () => {
    for (const x of [u, other]) {
      if (x.companyId) await prisma.organization.delete({ where: { id: x.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: x.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('رابط التتبّع: {n} يُستبدل برقم مُرمَّز، وبلا رقم لا رابط', () => {
    expect(trackLink('https://c.example/t?no={n}', 'AB 1/2')).toBe('https://c.example/t?no=AB%201%2F2');
    expect(trackLink('https://c.example/t?no={n}', '')).toBe('');
    expect(trackLink('https://c.example/track', '')).toBe('https://c.example/track');
    expect(trackLink('', 'X1')).toBe('');
  });

  it('الشركة تُضاف وتُعدَّل، والرقم يظهر للعميل بعد الشحن فقط، ويبقى بعد حذف الشركة', async () => {
    await request(http).post(`${base()}/carriers`).set(auth()).send({ name: 'سمسا', trackUrl: 'http://insecure/{n}' }).expect(400);
    const c = await request(http).post(`${base()}/carriers`).set(auth()).send({ name: 'سمسا', trackUrl: 'https://track.example/?awb={n}', phone: '8001234' }).expect(201);
    await request(http).patch(`${base()}/carriers/${c.body.id}`).set(auth()).send({ name: 'سمسا إكسبرس' }).expect(200);
    await request(http).get(`${base()}/carriers`).set(auth(other.token)).expect(404);

    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 1 }], name: 'منى', phone: '777000555' }).expect(201);
    const id = (await request(http).get(`${base()}/orders?q=${o.body.ref}`).set(auth()).expect(200)).body.orders[0].id;
    // قبل التأكيد لا شحن
    await request(http).patch(`${base()}/orders/${id}/shipping`).set(auth()).send({ carrierId: c.body.id, trackingNo: 'AWB-77' }).expect(400);
    await request(http).patch(`${base()}/orders/${id}`).set(auth()).send({ status: 1 }).expect(200);
    const s = await request(http).patch(`${base()}/orders/${id}/shipping`).set(auth()).send({ carrierId: c.body.id, trackingNo: 'AWB-77' }).expect(200);
    expect(s.body).toMatchObject({ carrierName: 'سمسا إكسبرس', trackingNo: 'AWB-77', trackUrl: 'https://track.example/?awb=AWB-77' });

    // مؤكد لم يُشحن بعد: العميل لا يرى الشحن
    let t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.body.ref}`).expect(200);
    expect(t.body.shipping).toBeNull();
    await request(http).patch(`${base()}/orders/${id}`).set(auth()).send({ status: 5 }).expect(200);
    t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.body.ref}`).expect(200);
    expect(t.body.shipping).toEqual({ carrier: 'سمسا إكسبرس', trackingNo: 'AWB-77', url: 'https://track.example/?awb=AWB-77' });

    // تصحيح الرقم وحده يعيد بناء الرابط من قالب الشركة
    const fix = await request(http).patch(`${base()}/orders/${id}/shipping`).set(auth()).send({ trackingNo: 'AWB-78' }).expect(200);
    expect(fix.body.trackUrl).toBe('https://track.example/?awb=AWB-78');
    const list = await request(http).get(`${base()}/carriers`).set(auth()).expect(200);
    expect(list.body.carriers[0].orders).toBe(1);

    await request(http).delete(`${base()}/carriers/${c.body.id}`).set(auth()).expect(200);
    t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.body.ref}`).expect(200);
    expect(t.body.shipping.carrier).toBe('سمسا إكسبرس');
    const one = await request(http).get(`${base()}/orders/${id}`).set(auth()).expect(200);
    expect(one.body.trackingNo).toBe('AWB-78');
  });
});
