import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * قسائم الخصم — الخادم وحده يحسب الخصم ويحجز الاستخدام.
 *
 * يثبت: الأنواع الثلاثة (نسبة بسقف، مبلغ، توصيل مجاني)، والحد الأدنى، والانتهاء،
 * وحدّ الاستخدام الكلي والذرّي، وحدّ العميل الواحد، والإلغاء يعيد الاستخدام،
 * وحدّ المفعّلة في المجانية، وعزل القسائم بين المتاجر، وظهورها في رسالة واتساب.
 */
describe('قسائم الخصم', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const RUN = randomUUID().slice(0, 8);
  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'coupon-pass-1234',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
  });
  const a = mk('coupon-a');
  const b = mk('coupon-b');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let storeId = '';
  let slug = '';
  let storeB = '';
  let productId = '';

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName })
      .expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
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

    await register(a);
    await register(b);
    slug = `cpn-${RUN}`;
    const s = await post('/shop/stores', a.token, { name: 'متجر القسائم', slug, country: 'YE', whatsapp: '777123456' }).expect(201);
    storeId = s.body.store.id;
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth(a.token))
      .send({ deliveryFee: 2000 }).expect(200);
    const p = await post(`/shop/stores/${storeId}/products`, a.token, { name: 'عطر', price: 10000, qty: 100, live: true }).expect(201);
    productId = p.body.id;
    const sb = await post('/shop/stores', b.token, { name: 'متجر آخر', slug: `cpn-b-${RUN}`, country: 'YE', whatsapp: '777123457' }).expect(201);
    storeB = sb.body.store.id;
  });

  afterAll(async () => {
    for (const u of [a, b]) {
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  const post = (path: string, token: string, body: object = {}) =>
    request(http).post(`/api/v1${path}`).set(auth(token)).send(body);
  const order = (body: object) =>
    request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: [{ id: productId, qty: 2 }], ...body });

  it('المتجر بلا قسائم لا يُظهر حقل الرمز', async () => {
    const r = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(r.body.coupons).toBe(false);
  });

  let pct = '';
  it('نسبة بسقف: الرمز يُحفظ بأحرف كبيرة، والمكرّر يُرفض', async () => {
    const r = await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'eid10', kind: 'percent', value: 10, maxDiscount: 1500 }).expect(201);
    pct = r.body.id;
    expect(r.body.code).toBe('EID10');
    expect(r.body.label).toContain('10%');
    await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'EID10', kind: 'amount', value: 5 }).expect(409);
    await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'x y', kind: 'amount', value: 5 }).expect(400);
    await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'BAD', kind: 'percent', value: 150 }).expect(400);
  });

  it('المعاينة تحسب الخصم والطلب يعيد الحساب في الخادم', async () => {
    const c = await request(http).post(`/api/v1/shop/storefront/${slug}/coupons/check`)
      .send({ code: ' eid10 ', subtotal: 20000, delivery: 2000 }).expect(201);
    expect(c.body.discount).toBe(1500); // ١٠٪ من ٢٠٬٠٠٠ = ٢٬٠٠٠ ← السقف ١٬٥٠٠
    const o = await order({ coupon: 'eid10', phone: '777000201' }).expect(201);
    expect(o.body.subtotal).toBe(20000);
    expect(o.body.discount).toBe(1500);
    expect(o.body.total).toBe(20000 + 2000 - 1500);
    expect(o.body.coupon).toBe('EID10');
    expect(decodeURIComponent(o.body.wa)).toContain('الخصم (EID10)');
    const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${o.body.ref}`).expect(200);
    expect(t.body.discount).toBe(1500);
  });

  it('رمز خاطئ يُفشل الطلب كله فلا يُخصم مخزون', async () => {
    const before = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth(a.token)).expect(200);
    const r = await order({ coupon: 'NOPE99' }).expect(400);
    expect(JSON.stringify(r.body)).toContain('غير صحيح');
    const after = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth(a.token)).expect(200);
    expect(after.body.qty).toBe(before.body.qty);
  });

  it('مبلغ ثابت بحد أدنى، وتوصيل مجاني', async () => {
    await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'SAVE5K', kind: 'amount', value: 5000, minSubtotal: 30000 }).expect(201);
    const low = await order({ coupon: 'SAVE5K' }).expect(400);
    expect(JSON.stringify(low.body)).toContain('فأكثر');
    const ok = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`)
      .send({ lines: [{ id: productId, qty: 3 }], coupon: 'save5k' }).expect(201);
    expect(ok.body.total).toBe(30000 + 2000 - 5000);

    // الثالثة المفعّلة: توصيل مجاني — الخصم = رسم التوصيل
    await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'FREESHIP', kind: 'ship', value: 99 }).expect(201);
    const ship = await order({ coupon: 'FREESHIP' }).expect(201);
    expect(ship.body.delivery).toBe(2000);
    expect(ship.body.discount).toBe(2000);
    expect(ship.body.total).toBe(20000);
  });

  it('حدّ المفعّلة معًا في المجانية ٣ — المعطّلة لا تُحسب', async () => {
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/coupons`).set(auth(a.token)).expect(200);
    expect(list.body.limit).toBe(3);
    const active = list.body.coupons.filter((c: { active: boolean }) => c.active).length;
    expect(active).toBe(3);
    const off = await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'LATER', kind: 'amount', value: 100, active: false }).expect(201);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/coupons/${off.body.id}`).set(auth(a.token)).send({ active: true }).expect(400);
  });

  it('حدّ الاستخدام الكلي ذرّي، والإلغاء يعيد الاستخدام', async () => {
    // نوقف النسبة ونفعّل قسيمة بحدّ ١
    await request(http).patch(`/api/v1/shop/stores/${storeId}/coupons/${pct}`).set(auth(a.token)).send({ active: false }).expect(200);
    const one = await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'ONCE', kind: 'amount', value: 1000, usageLimit: 1 }).expect(201);
    const results = await Promise.all([1, 2, 3].map(() => order({ coupon: 'ONCE' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const won = results.find((r) => r.status === 201)!;

    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${won.body.ref}`).set(auth(a.token)).expect(200);
    const id = list.body.orders[0].id;
    await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${id}`).set(auth(a.token)).send({ status: 3 }).expect(200);
    const c = await prisma.shopCoupon.findUniqueOrThrow({ where: { id: one.body.id } });
    expect(c.used).toBe(0);
    await order({ coupon: 'ONCE' }).expect(201);
  });

  it('حدّ العميل الواحد يُعرف برقم الجوال بأي صيغة', async () => {
    const all = await request(http).get(`/api/v1/shop/stores/${storeId}/coupons`).set(auth(a.token)).expect(200);
    const once = all.body.coupons.find((c: { code: string }) => c.code === 'ONCE');
    await request(http).patch(`/api/v1/shop/stores/${storeId}/coupons/${once.id}`).set(auth(a.token)).send({ active: false }).expect(200);
    await post(`/shop/stores/${storeId}/coupons`, a.token, { code: 'WELCOME', kind: 'percent', value: 5, perCustomer: 1 }).expect(201);
    await order({ coupon: 'WELCOME' }).expect(400); // بلا رقم
    await order({ coupon: 'WELCOME', phone: '0777000301' }).expect(201);
    const again = await order({ coupon: 'WELCOME', phone: '+967777000301' }).expect(400);
    expect(JSON.stringify(again.body)).toContain('من قبل');
  });

  it('المنتهية ترفض، والقسيمة لا تعمل في متجر آخر ولا يراها غير مالكها', async () => {
    const ended = await post(`/shop/stores/${storeId}/coupons`, a.token, {
      code: 'OLD', kind: 'amount', value: 100, active: false, endsAt: new Date(Date.now() - 86_400_000).toISOString(),
    }).expect(201);
    await prisma.shopCoupon.update({ where: { id: ended.body.id }, data: { active: true } });
    const r = await order({ coupon: 'OLD' }).expect(400);
    expect(JSON.stringify(r.body)).toContain('انتهت');

    await request(http).get(`/api/v1/shop/stores/${storeId}/coupons`).set(auth(b.token)).expect(404);
    await request(http).post(`/api/v1/shop/storefront/cpn-b-${RUN}/coupons/check`).send({ code: 'WELCOME' }).expect(400);
    expect(storeB).toBeTruthy();
  });

  it('جاهزية المتجر تُحسب من بياناته: القسيمة والطلب منجزان، والشعار ناقص', async () => {
    const r = await request(http).get(`/api/v1/shop/stores/${storeId}/readiness`).set(auth(a.token)).expect(200);
    const by = Object.fromEntries((r.body.tasks as { key: string; done: boolean }[]).map((t) => [t.key, t.done]));
    expect(by.coupon).toBe(true);
    expect(by.firstOrder).toBe(true);
    expect(by.delivery).toBe(true); // رسم توصيل عام
    expect(by.logo).toBe(false);
    expect(by.products).toBe(false); // منتج واحد
    expect(r.body.total).toBe(14);
    expect(r.body.percent).toBe(Math.round((r.body.done / 14) * 100));
    await request(http).get(`/api/v1/shop/stores/${storeId}/readiness`).set(auth(b.token)).expect(404);
  });

  it('واجهة المتجر تعلن وجود قسيمة مفعّلة، واللوحة تعرض أثر كل قسيمة', async () => {
    const r = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(r.body.coupons).toBe(true);
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/coupons`).set(auth(a.token)).expect(200);
    const eid = list.body.coupons.find((c: { code: string }) => c.code === 'EID10');
    expect(eid.orders).toBe(1);
    expect(eid.discounted).toBe(1500);
  });
});
