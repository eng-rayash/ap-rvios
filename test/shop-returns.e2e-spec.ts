import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/** المرتجعات: طلب العميل لطلب مكتمل، وقبول/رفض/إتمام التاجر، والمخزون، وخروج الطلب من المبيعات. */
describe('المرتجعات', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const RUN = randomUUID().slice(0, 8);
  const u = { email: `ret-${randomUUID()}@azm.test`, token: '', companyId: '' };
  const other = { email: `ret2-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let productId = '';
  const auth = (t = u.token) => ({ Authorization: `Bearer ${t}` });

  async function reg(x: typeof u) {
    const r = await request(http).post('/api/v1/auth/register').send({ email: x.email, password: 'ret-pass-12345', displayName: 'تاجر المرتجعات', companyName: 'شركة المرتجعات' }).expect(201);
    x.token = r.body.accessToken;
    x.companyId = r.body.company.id;
  }
  async function doneOrder(qty = 2) {
    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty }], name: 'عميل', phone: '777000444' }).expect(201);
    const l = await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${o.body.ref}`).set(auth()).expect(200);
    const id = l.body.orders[0].id;
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${id}`).set(auth()).send({ status: 1 }).expect(200);
    return { ref: o.body.ref as string, id, total: o.body.total as number };
  }
  const qty = async () => (await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth()).expect(200)).body.qty as number;

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
    await reg(u);
    await reg(other);
    slug = `ret-${RUN}`;
    const s = await request(http).post('/api/v1/shop/stores').set(auth()).send({ name: 'متجر المرتجعات', slug, country: 'YE', whatsapp: '777123456' }).expect(201);
    storeId = s.body.store.id;
    const p = await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth()).send({ name: 'حذاء', price: 10000, qty: 20, live: true }).expect(201);
    productId = p.body.id;
  });

  afterAll(async () => {
    for (const x of [u, other]) {
      if (x.companyId) await prisma.organization.delete({ where: { id: x.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: x.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('العميل يطلب الاسترجاع بعد الاكتمال فقط، ومرة واحدة مفتوحة', async () => {
    const o = await doneOrder();
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders/${o.ref}/return`).send({ reason: 'المقاس صغير جدًا' }).expect(409); // مؤكد لا مكتمل
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${o.id}`).set(auth()).send({ status: 2 }).expect(200);
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders/${o.ref}/return`).send({ reason: 'المقاس صغير جدًا' }).expect(201);
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders/${o.ref}/return`).send({ reason: 'مرة ثانية' }).expect(409);
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.ref}`).expect(200);
    expect(t.body.return.status).toBe(0);
    expect(t.body.id).toBeUndefined();

    const l = await request(http).get(`/api/v1/shop/stores/${storeId}/returns`).set(auth()).expect(200);
    expect(l.body.counts['0']).toBe(1);
    expect(l.body.returns[0].order.ref).toBe(o.ref);
    await request(http).get(`/api/v1/shop/stores/${storeId}/returns`).set(auth(other.token)).expect(404);
  });

  it('الإتمام يعيد المخزون، ويحوّل الطلب «مُرجَعًا» فيخرج من المبيعات، والمبلغ لا يتجاوز الإجمالي', async () => {
    const l = await request(http).get(`/api/v1/shop/stores/${storeId}/returns?status=0`).set(auth()).expect(200);
    const r = l.body.returns[0];
    const before = await qty();
    await request(http).patch(`/api/v1/shop/stores/${storeId}/returns/${r.id}`).set(auth()).send({ status: 1 }).expect(200);
    const done = await request(http).patch(`/api/v1/shop/stores/${storeId}/returns/${r.id}`).set(auth()).send({ status: 3, refund: 999999, note: 'أُعيد المبلغ للكريمي' }).expect(200);
    expect(done.body.refund).toBe(r.order.total);
    expect(await qty()).toBe(before + 2);
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${r.order.ref}`).expect(200);
    expect(t.body.status).toBe(6);
    expect(t.body.return).toMatchObject({ status: 3, note: 'أُعيد المبلغ للكريمي' });
    await request(http).patch(`/api/v1/shop/stores/${storeId}/returns/${r.id}`).set(auth()).send({ status: 2 }).expect(409); // مغلق
    const a = await request(http).get(`/api/v1/shop/stores/${storeId}/analytics?days=7`).set(auth()).expect(200);
    expect(a.body.totals.soldOrders).toBe(0);
    expect(a.body.byStatus['6']).toBe(1);
  });

  it('السلات المتروكة: تُحفظ بأسعار القاعدة وتظهر بعد مهلة برسالة تذكير، والطلب بالرقم نفسه يستعيدها', async () => {
    const save = (phone: string) => request(http).post(`/api/v1/shop/storefront/${slug}/carts`).send({ phone, name: 'ليلى', lines: [{ id: productId, qty: 2 }] });
    await save('0777000321').expect(201);
    await save('777000321').expect(201); // الرقم نفسه بصيغة أخرى: سلة واحدة
    await save('123').expect(400);
    let l = await request(http).get(`/api/v1/shop/stores/${storeId}/carts`).set(auth()).expect(200);
    expect(l.body.carts).toHaveLength(0); // لم تمض المهلة
    await prisma.shopCart.updateMany({ where: { storeId }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
    l = await request(http).get(`/api/v1/shop/stores/${storeId}/carts`).set(auth()).expect(200);
    expect(l.body.carts).toHaveLength(1);
    expect(l.body.carts[0].subtotal).toBe(20000);
    expect(decodeURIComponent(l.body.carts[0].wa)).toContain('تركت سلتك');
    expect(l.body.stats.openValue).toBe(20000);
    await request(http).post(`/api/v1/shop/stores/${storeId}/carts/${l.body.carts[0].id}/reminded`).set(auth()).expect(201);
    await request(http).get(`/api/v1/shop/stores/${storeId}/carts`).set(auth(other.token)).expect(404);

    await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 1 }], name: 'ليلى', phone: '+967777000321' }).expect(201);
    l = await request(http).get(`/api/v1/shop/stores/${storeId}/carts`).set(auth()).expect(200);
    expect(l.body.carts).toHaveLength(0);
    expect(l.body.stats.recovered).toBe(1);
    const r = await request(http).get(`/api/v1/shop/stores/${storeId}/carts?status=1`).set(auth()).expect(200);
    expect(r.body.carts[0].recoveredOrderId).toBeTruthy();
  });

  it('المكافآت: ٪ من الطلب المكتمل للعميل مرة واحدة، تُسحب بالإرجاع، وتُصرف في الطلب اليدوي، ويراها العميل', async () => {
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ loyaltyRate: 5 }).expect(200);
    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 2 }], name: 'وفاء', phone: '777000888' }).expect(201);
    const id = (await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${o.body.ref}`).set(auth()).expect(200)).body.orders[0].id;
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${id}`).set(auth()).send({ status: 1 }).expect(200);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${id}`).set(auth()).send({ status: 2 }).expect(200);
    const cs = await request(http).get(`/api/v1/shop/stores/${storeId}/customers`).set(auth()).expect(200);
    const c = (cs.body.customers as { id: string; phone: string; points: number }[]).find((x) => x.phone.endsWith('777000888'))!;
    expect(c.points).toBe(1000); // ٥٪ من ٢٠٬٠٠٠
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.body.ref}`).expect(200);
    expect(t.body.points).toBe(1000);

    // صرف ٦٠٠ في طلب يدوي، ولا يُصرف أكثر من الرصيد
    await request(http).post(`/api/v1/shop/stores/${storeId}/orders`).set(auth()).send({ lines: [{ id: productId, qty: 1 }], phone: '0777000888', pointsUsed: 5000 }).expect(400);
    const m = await request(http).post(`/api/v1/shop/stores/${storeId}/orders`).set(auth()).send({ lines: [{ id: productId, qty: 1 }], phone: '0777000888', pointsUsed: 600 }).expect(201);
    expect(m.body.discount).toBe(600);
    let h = await request(http).get(`/api/v1/shop/stores/${storeId}/customers/${c.id}/points`).set(auth()).expect(200);
    expect(h.body.customer.points).toBe(400);

    // إرجاع الطلب الأول يسحب ما كُسب منه بقدر المتبقي
    await request(http).post(`/api/v1/shop/stores/${storeId}/returns`).set(auth()).send({ orderId: id, complete: true }).expect(201);
    h = await request(http).get(`/api/v1/shop/stores/${storeId}/customers/${c.id}/points`).set(auth()).expect(200);
    expect(h.body.customer.points).toBe(0);
    expect(h.body.history.map((x: { kind: string }) => x.kind)).toEqual(['revoke', 'redeem', 'earn']);

    await request(http).post(`/api/v1/shop/stores/${storeId}/customers/${c.id}/points`).set(auth()).send({ amount: 250, note: 'هدية' }).expect(201);
    await request(http).post(`/api/v1/shop/stores/${storeId}/customers/${c.id}/points`).set(auth()).send({ amount: -999 }).expect(400);
    await request(http).post(`/api/v1/shop/stores/${storeId}/customers/${c.id}/points`).set(auth(other.token)).send({ amount: 5 }).expect(404);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${m.body.id}`).set(auth()).send({ status: 3 }).expect(200);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ loyaltyRate: 0 }).expect(200);
  });

  it('التاجر يسجّل مرتجعًا مكتملًا فورًا بلا إعادة مخزون، والرفض يظهر للعميل بملاحظته', async () => {
    const o = await doneOrder(1);
    await request(http).post(`/api/v1/shop/stores/${storeId}/returns`).set(auth()).send({ orderId: o.id }).expect(409); // مؤكد فقط
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${o.id}`).set(auth()).send({ status: 2 }).expect(200);
    const before = await qty();
    const m = await request(http).post(`/api/v1/shop/stores/${storeId}/returns`).set(auth()).send({ orderId: o.id, reason: 'تالف', refund: 4000, restock: false, complete: true }).expect(201);
    expect(m.body.status).toBe(3);
    expect(m.body.refund).toBe(4000);
    expect(await qty()).toBe(before);

    const o2 = await doneOrder(1);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${o2.id}`).set(auth()).send({ status: 2 }).expect(200);
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders/${o2.ref}/return`).send({ reason: 'غيّرت رأيي فيه' }).expect(201);
    const l = await request(http).get(`/api/v1/shop/stores/${storeId}/returns?status=0`).set(auth()).expect(200);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/returns/${l.body.returns[0].id}`).set(auth()).send({ status: 2, note: 'المنتج مستعمل' }).expect(200);
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o2.ref}`).expect(200);
    expect(t.body.status).toBe(2);
    expect(t.body.return).toMatchObject({ status: 2, note: 'المنتج مستعمل' });
  });
});
