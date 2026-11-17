import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/** أسئلة المنتجات: الزائر يسأل، والتاجر يجيب، ولا يظهر للعامة إلا المُجاب المنشور. */
describe('أسئلة المنتجات', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const RUN = randomUUID().slice(0, 8);
  const a = { email: `qa-${randomUUID()}@azm.test`, token: '', companyId: '' };
  const b = { email: `qb-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let productId = '';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function reg(u: typeof a) {
    const r = await request(http).post('/api/v1/auth/register').send({ email: u.email, password: 'qa-pass-12345', displayName: 'تاجر الأسئلة', companyName: 'شركة الأسئلة' }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
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
    await reg(a);
    await reg(b);
    slug = `qa-${RUN}`;
    const s = await request(http).post('/api/v1/shop/stores').set(auth(a.token)).send({ name: 'متجر الأسئلة', slug, country: 'YE', whatsapp: '777123456' }).expect(201);
    storeId = s.body.store.id;
    const p = await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth(a.token)).send({ name: 'عطر', price: 1000, qty: 5, live: true }).expect(201);
    productId = p.body.id;
  });

  afterAll(async () => {
    for (const u of [a, b]) {
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('سؤال الزائر لا يظهر قبل الإجابة، ويظهر بعدها، والمخفي يختفي', async () => {
    await request(http).post(`/api/v1/shop/storefront/${slug}/products/${productId}/questions`).send({ question: 'هل هو أصلي؟', name: 'سالم' }).expect(201);
    await request(http).post(`/api/v1/shop/storefront/${slug}/products/${productId}/questions`).send({ question: 'هل يوجد حجم أكبر؟' }).expect(201);
    await request(http).post(`/api/v1/shop/storefront/${slug}/products/${productId}/questions`).send({ question: 'لا' }).expect(400);

    let pub = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/questions`).expect(200);
    expect(pub.body.questions).toHaveLength(0);

    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/questions`).set(auth(a.token)).expect(200);
    expect(list.body.counts['0']).toBe(2);
    const q = list.body.questions.find((x: { question: string }) => x.question === 'هل هو أصلي؟');
    expect(q.product.name).toBe('عطر');

    await request(http).patch(`/api/v1/shop/stores/${storeId}/questions/${q.id}`).set(auth(a.token)).send({ status: 1 }).expect(400); // بلا إجابة
    const ans = await request(http).patch(`/api/v1/shop/stores/${storeId}/questions/${q.id}`).set(auth(a.token)).send({ answer: ' نعم، أصلي ١٠٠٪ ' }).expect(200);
    expect(ans.body.status).toBe(1);
    expect(ans.body.answeredAt).toBeTruthy();

    pub = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/questions`).expect(200);
    expect(pub.body.questions).toEqual([expect.objectContaining({ question: 'هل هو أصلي؟', answer: 'نعم، أصلي ١٠٠٪', name: 'سالم' })]);
    expect(JSON.stringify(pub.body)).not.toContain(a.companyId);

    await request(http).patch(`/api/v1/shop/stores/${storeId}/questions/${q.id}`).set(auth(a.token)).send({ status: 2 }).expect(200);
    pub = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/questions`).expect(200);
    expect(pub.body.questions).toHaveLength(0);
  });

  it('«يُشترى معًا غالبًا» من الطلبات الحقيقية: الأكثر اقترانًا أولًا، بلا الملغى ولا النافد', async () => {
    const mk = async (name: string, qty = 10) => (await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth(a.token)).send({ name, price: 500, qty, live: true }).expect(201)).body.id as string;
    const kohl = await mk('كحل');
    const box = await mk('علبة هدية');
    const gone = await mk('نفد', 1);
    const order = async (ids: string[], cancel = false) => {
      process.env.SHOP_ORDER_LIMIT = '1000';
      const o = await request(http).post(`/api/v1/shop/storefront/${slug}/orders`).send({ lines: ids.map((id) => ({ id, qty: 1 })), name: 'ع' }).expect(201);
      const l = await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${o.body.ref}`).set(auth(a.token)).expect(200);
      await request(http).patch(`/api/v1/shop/stores/${storeId}/orders/${l.body.orders[0].id}`).set(auth(a.token)).send({ status: cancel ? 3 : 1 }).expect(200);
    };
    let r = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/together`).expect(200);
    expect(r.body.ids).toEqual([]);
    await order([productId, kohl, box]);
    await order([productId, box]);
    await order([productId, gone]); // نفد بعدها
    await order([productId, kohl], true); // ملغى لا يُحسب
    r = await request(http).get(`/api/v1/shop/storefront/${slug}/products/${productId}/together`).expect(200);
    expect(r.body.ids).toEqual([box, kohl]);
  });

  it('الخيارات المحفوظة: الحفظ بالاسم يحدّث، والقيم تُنظّف، وخاصة بالمتجر', async () => {
    const save = (body: object, t = a.token) => request(http).post(`/api/v1/shop/stores/${storeId}/option-sets`).set(auth(t)).send(body);
    const s1 = await save({ name: 'المقاس', values: ['S', ' M ', 'M', '', 'L'] }).expect(201);
    expect(s1.body.values).toEqual(['S', 'M', 'L']);
    await save({ name: 'المقاس', values: ['M', 'L', 'XL'] }).expect(201);
    const l = await request(http).get(`/api/v1/shop/stores/${storeId}/option-sets`).set(auth(a.token)).expect(200);
    expect(l.body).toHaveLength(1);
    expect(l.body[0].values).toEqual(['M', 'L', 'XL']);
    await request(http).get(`/api/v1/shop/stores/${storeId}/option-sets`).set(auth(b.token)).expect(404);
    await save({ name: 'فارغ', values: [] }).expect(400);
    await request(http).delete(`/api/v1/shop/stores/${storeId}/option-sets/${l.body[0].id}`).set(auth(a.token)).expect(200);
  });

  it('تاجر آخر لا يرى أسئلة المتجر ولا يعدّلها، ومنتج مجهول ٤٠٤', async () => {
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/questions`).set(auth(a.token)).expect(200);
    const id = list.body.questions[0].id;
    await request(http).get(`/api/v1/shop/stores/${storeId}/questions`).set(auth(b.token)).expect(404);
    await request(http).patch(`/api/v1/shop/stores/${storeId}/questions/${id}`).set(auth(b.token)).send({ answer: 'x' }).expect(404);
    await request(http).post(`/api/v1/shop/storefront/${slug}/products/${randomUUID()}/questions`).send({ question: 'سؤال عن منتج مجهول' }).expect(404);
    await request(http).delete(`/api/v1/shop/stores/${storeId}/questions/${id}`).set(auth(a.token)).expect(200);
  });
});
