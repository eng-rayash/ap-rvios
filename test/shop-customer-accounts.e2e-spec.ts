import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { CustomerMessenger } from '../src/modules/shop/customers/customer-accounts';

/** حسابات العملاء: الدخول برمز الجوال، والمحفظة والمكافآت في الطلب، والإلغاء والمرتجع يعيدانها، والإشعارات. */
describe('حسابات العملاء ومحافظهم وإشعاراتهم', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  let outbox: Map<string, string>;
  const u = { email: `acc-${randomUUID()}@azm.test`, token: '', companyId: '' };
  const other = { email: `acc2-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let slug2 = '';
  let productId = '';
  let customerToken = '';
  let customerId = '';
  const PHONE = '967771234567';
  const auth = (t = u.token) => ({ Authorization: `Bearer ${t}` });
  const ct = (t = customerToken) => ({ 'X-Customer-Token': t });
  const base = () => `/api/v1/shop/stores/${storeId}`;
  const acc = (s = slug) => `/api/v1/shop/storefront/${s}/account`;
  const codeOf = (phone: string) => /(\d{6})/.exec(outbox.get(phone) ?? '')?.[1] ?? '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    outbox = app.get(CustomerMessenger).outbox;
    for (const x of [u, other]) {
      const r = await request(http).post('/api/v1/auth/register').send({ email: x.email, password: 'acc-pass-12345', displayName: 'تاجر الحسابات', companyName: 'شركة الحسابات' }).expect(201);
      x.token = r.body.accessToken;
      x.companyId = r.body.company.id;
    }
    slug = `acc-${randomUUID().slice(0, 8)}`;
    slug2 = `acc2-${randomUUID().slice(0, 8)}`;
    storeId = (await request(http).post('/api/v1/shop/stores').set(auth()).send({ name: 'متجر الحسابات', slug, country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    await request(http).post('/api/v1/shop/stores').set(auth(other.token)).send({ name: 'متجر آخر', slug: slug2, country: 'YE', whatsapp: '777123457' }).expect(201);
    productId = (await request(http).post(`${base()}/products`).set(auth()).send({ name: 'ساعة', price: 10000, qty: 50, live: true }).expect(201)).body.id;
  });

  afterAll(async () => {
    for (const x of [u, other]) {
      if (x.companyId) await prisma.organization.delete({ where: { id: x.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: x.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('الدخول برمز: يُرسل للجوال، والخطأ يُعدّ، والصحيح يعطي جلسة لهذا المتجر وحده لا تصلح للتاجر', async () => {
    const pub = await request(http).get(`/api/v1/shop/storefront/${slug}`).expect(200);
    expect(JSON.stringify(pub.body)).toContain('"accounts":true');
    await request(http).post(`${acc()}/otp`).send({ phone: '12' }).expect(400);
    const r = await request(http).post(`${acc()}/otp`).send({ phone: '0771234567' }).expect(201);
    expect(r.body.phone).toBe(PHONE);
    await request(http).post(`${acc()}/otp`).send({ phone: '771234567' }).expect(400); // دقيقة بين الرموز
    const code = codeOf(PHONE);
    expect(code).toMatch(/^\d{6}$/);
    await request(http).post(`${acc()}/verify`).send({ phone: PHONE, code: code === '000000' ? '111111' : '000000' }).expect(401);
    const v = await request(http).post(`${acc()}/verify`).send({ phone: '+967771234567', code }).expect(201);
    customerToken = v.body.token;
    customerId = v.body.customer.id;
    // الرمز لا يُستعمل مرتين
    await request(http).post(`${acc()}/verify`).send({ phone: PHONE, code }).expect(401);

    const me = await request(http).get(acc()).set(ct()).expect(200);
    expect(me.body.customer).toMatchObject({ phone: PHONE, wallet: 0, points: 0 });
    await request(http).get(acc()).expect(401);
    await request(http).get(acc(slug2)).set(ct()).expect(401);
    // رمز العميل ليس رمز تاجر
    await request(http).get(base()).set(auth(customerToken)).expect(401);
    await request(http).patch(acc()).set(ct()).send({ name: 'سلمى', address: 'صنعاء — حدة' }).expect(200);
  });

  it('المحفظة: التاجر يضيف فيصل إشعار، والعميل يدفع منها جزءًا، والإلغاء يعيد المبلغ والمكافآت', async () => {
    await request(http).post(`${base()}/customers/${customerId}/wallet`).set(auth()).send({ amount: 15000, note: 'تعويض تأخير' }).expect(201);
    await request(http).post(`${base()}/customers/${customerId}/wallet`).set(auth(other.token)).send({ amount: 5 }).expect(404);
    await prisma.shopCustomer.update({ where: { id: customerId }, data: { points: 700 } });

    // بلا جلسة لا صرف
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 1 }], phone: PHONE, walletUsed: 100 }).expect(400);
    // أكثر من الرصيد يُرفض كله
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).set(ct()).send({ lines: [{ id: productId, qty: 1 }], walletUsed: 99999 }).expect(201)
      .then((r) => expect(r.body.walletPaid).toBe(10000)); // يُقصّ إلى الإجمالي
    let me = await request(http).get(acc()).set(ct()).expect(200);
    expect(me.body.customer.wallet).toBe(5000);

    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).set(ct()).send({ lines: [{ id: productId, qty: 2 }], walletUsed: 3000, pointsUsed: 500, phone: '700000000' }).expect(201);
    expect(o.body).toMatchObject({ total: 19500, discount: 500, walletPaid: 3000 });
    me = await request(http).get(acc()).set(ct()).expect(200);
    expect(me.body.customer).toMatchObject({ wallet: 2000, points: 200 });

    const orders = await request(http).get(`${acc()}/orders`).set(ct()).expect(200);
    expect(orders.body.orders).toHaveLength(2);
    const id = (await request(http).get(`${base()}/orders?q=${o.body.ref}`).set(auth()).expect(200)).body.orders[0].id;
    await request(http).patch(`${base()}/orders/${id}`).set(auth()).send({ status: 3, reason: 'نفد اللون' }).expect(200);
    me = await request(http).get(acc()).set(ct()).expect(200);
    expect(me.body.customer).toMatchObject({ wallet: 5000, points: 700 });

    const w = await request(http).get(`${acc()}/wallet`).set(ct()).expect(200);
    expect(w.body.history.map((x: { kind: string }) => x.kind)).toEqual(['cancel', 'pay', 'pay', 'credit']);
    const n = await request(http).get(`${acc()}/notices`).set(ct()).expect(200);
    expect(n.body.notices.some((x: { title: string; body: string }) => x.title.startsWith('أُلغي طلبك') && x.body.includes('نفد اللون'))).toBe(true);
    expect(n.body.notices.some((x: { kind: string }) => x.kind === 'wallet')).toBe(true);
    expect(me.body.unread).toBeGreaterThan(1);
    await request(http).post(`${acc()}/notices/read`).set(ct()).expect(201);
    expect((await request(http).get(acc()).set(ct()).expect(200)).body.unread).toBe(0);
  });

  it('المرتجع يُستردّ إلى المحفظة، والإشعار الجماعي يصل بحسب الجمهور ومحدود يوميًا', async () => {
    const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).set(ct()).send({ lines: [{ id: productId, qty: 1 }] }).expect(201);
    const id = (await request(http).get(`${base()}/orders?q=${o.body.ref}`).set(auth()).expect(200)).body.orders[0].id;
    for (const s of [1, 2]) await request(http).patch(`${base()}/orders/${id}`).set(auth()).send({ status: s }).expect(200);
    const r = await request(http).post(`${base()}/returns`).set(auth()).send({ orderId: id }).expect(201);
    await request(http).patch(`${base()}/returns/${r.body.id}`).set(auth()).send({ status: 3, refund: 4000, toWallet: true }).expect(200);
    expect((await request(http).get(acc()).set(ct()).expect(200)).body.customer.wallet).toBe(9000);

    // عميل بلا حساب (طلب برقمه فقط) لا يدخل جمهور «الحسابات»
    await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 1 }], phone: '773000111' }).expect(201);
    const b = await request(http).post(`${base()}/broadcasts`).set(auth()).send({ title: 'تخفيضات الجمعة', body: 'خصم ٢٠٪ على كل الساعات', link: '/shop', audience: 'accounts' }).expect(201);
    expect(b.body.recipients).toBe(1);
    const all = await request(http).post(`${base()}/broadcasts`).set(auth()).send({ title: 'وصل الجديد', body: 'تشكيلة الشتاء', audience: 'all', sms: true }).expect(201);
    expect(all.body.recipients).toBe(2);
    expect(all.body.sent).toBe(2);
    await request(http).post(`${base()}/broadcasts`).set(auth()).send({ title: 'x', body: 'y', audience: 'all' }).expect(400);
    await request(http).post(`${base()}/broadcasts`).set(auth()).send({ title: 'رابط', body: 'خارجي', link: 'https://evil.example', audience: 'all' }).expect(400);
    const list = await request(http).get(`${base()}/broadcasts`).set(auth()).expect(200);
    expect(list.body.audience).toMatchObject({ all: 2, accounts: 1 });
    const n = await request(http).get(`${acc()}/notices`).set(ct()).expect(200);
    expect(n.body.notices[0]).toMatchObject({ kind: 'broadcast', title: 'وصل الجديد' });
  });
});
