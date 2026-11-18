import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { AI_PROVIDER, AiChunk, AiProvider, AiRequest } from '../src/modules/ai/providers/ai-provider';
import { upgradeStore } from './helpers/plan';

class FakeProvider implements AiProvider {
  readonly name = 'fake';
  ready = true;
  calls: AiRequest[] = [];
  async *stream(req: AiRequest): AsyncIterable<AiChunk> {
    this.calls.push(req);
    yield { type: 'text', text: 'أنصحك بهذا:\n' };
    yield { type: 'done', usage: { model: 'fake-1', inputTokens: 30, outputTokens: 8, thoughtsTokens: 0 }, finish: 'STOP' };
  }
}

/** أوضاع البيع: الجملة بلا أسعار (في الخادم لا العرض) وطلب التسعير، والمساعد الذكي بمعرفة المتجر — كلاهما ميزة باقة. */
describe('وضع الجملة والمساعد الذكي في المتجر', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const fake = new FakeProvider();
  const u = { email: `modes-${randomUUID()}@azm.test`, token: '', companyId: '' };
  let storeId = '';
  let slug = '';
  let productId = '';
  const auth = () => ({ Authorization: `Bearer ${u.token}` });
  const pub = (p = '') => `/api/v1/shop/storefront/${slug}${p}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER).useValue(fake).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    const r = await request(http).post('/api/v1/auth/register').send({ email: u.email, password: 'modes-pass-12345', displayName: 'تاجر الجملة', companyName: 'شركة الجملة' }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    slug = `modes-${randomUUID().slice(0, 8)}`;
    storeId = (await request(http).post('/api/v1/shop/stores').set(auth()).send({ name: 'مستودع الجملة', slug, country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    productId = (await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth()).send({ name: 'كرتون زيت ٢٤ عبوة', price: 42000, qty: 500, live: true, description: 'زيت طبخ نباتي' }).expect(201)).body.id;
  });

  afterAll(async () => {
    if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
    await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    await app.close();
  });

  it('الباقة تحكم: التفعيل على المجانية يُرفض برمز الميزة، والإيقاف متاح', async () => {
    const r = await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ wholesale: true }).expect(409);
    expect(JSON.stringify(r.body)).toContain('PLAN_FEATURE');
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ aiAssistant: true }).expect(409);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ wholesale: false }).expect(200);
    const s = await request(http).get(`/api/v1/shop/stores/${storeId}`).set(auth()).expect(200);
    expect(s.body.store.features.wholesale).toBe(false);
    expect(s.body.store.planName).toBe('المجانية');
  });

  it('الجملة: لا سعر في أي رد عام، والطلب «طلب تسعير» بلا مبالغ للعميل وبأسعاره للتاجر', async () => {
    await upgradeStore(prisma, u.companyId, storeId, 3);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ wholesale: true }).expect(200);

    const cat = await request(http).get(pub('/catalogue')).expect(200);
    expect(cat.body.store.wholesale).toBe(true);
    expect(JSON.stringify(cat.body)).not.toContain('42000');
    const one = await request(http).get(pub(`/products/${productId}`)).expect(200);
    expect(JSON.stringify(one.body)).not.toContain('42000');
    const list = await request(http).get(pub('/products')).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('42000');

    const o = await request(http).post(pub('/orders')).send({ lines: [{ id: productId, qty: 40 }], name: 'بقالة الأمل', phone: '777555111', payMethod: 'bank', coupon: 'X' }).expect(201);
    expect(o.body).toMatchObject({ ok: true, quote: true });
    expect(o.body.total).toBeUndefined();
    const t = await request(http).get(pub(`/orders/${o.body.ref}`)).expect(200);
    expect(t.body.total).toBeNull();
    expect(t.body.items[0].price).toBeNull();

    const mine = await request(http).get(`/api/v1/shop/stores/${storeId}/orders?q=${o.body.ref}`).set(auth()).expect(200);
    expect(mine.body.orders[0]).toMatchObject({ source: 'quote', total: 42000 * 40, payMethod: 'cod' });
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ wholesale: false }).expect(200);
    expect(JSON.stringify((await request(http).get(pub('/catalogue')).expect(200)).body)).toContain('42000');
  });

  it('المساعد: مغلق حتى يُفعَّل، ثم يرد بمعرفة منتجات المتجر وحده', async () => {
    const ask = () => request(http).post(pub('/assistant')).send({ turns: [{ role: 'user', text: 'أبغى زيت للمطعم' }], productId });
    await ask().expect(404);
    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ aiAssistant: true }).expect(200);
    const r = await ask().buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c: Buffer) => (d += c)); res.on('end', () => cb(null, d)); }).expect(200);
    expect(String(r.body)).toContain('event: done');
    const sys = fake.calls.at(-1)!.system;
    expect(sys).toContain(`[[p:${productId}]] كرتون زيت ٢٤ عبوة`);
    expect(sys).toContain('42,000');
    expect(sys).toContain('العميل يتصفح الآن');
    expect(sys).not.toContain('cost');
    const pubStore = await request(http).get(pub('/catalogue')).expect(200);
    expect(pubStore.body.store.storeAI).toBe(true);
    // هبوط الباقة يطفئه
    await upgradeStore(prisma, u.companyId, storeId, 0);
    await ask().expect(404);
  });
});
