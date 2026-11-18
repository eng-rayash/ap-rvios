import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { upgradeStore } from './helpers/plan';

/** صلاحيات الموظفين بالأقسام: الخادم يمنع ما لم يُمنح، ويخفي التكلفة عمّن لا يرى الأرباح. */
describe('أقسام المتجر للموظفين', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const RUN = randomUUID().slice(0, 8);
  const owner = { email: `sec-${randomUUID()}@azm.test`, token: '', companyId: '' };
  const staff = { email: `sec-staff-${randomUUID()}@azm.test`, password: 'staff-pass-12345', token: '', memberId: '' };
  let storeId = '';
  let productId = '';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async () => {
    const r = await request(http).post('/api/v1/auth/login').send({ email: staff.email, password: staff.password, companyId: owner.companyId }).expect(200);
    staff.token = r.body.accessToken;
  };
  const setSections = (sections: string[] | null, role?: number) =>
    request(http).patch(`/api/v1/team/members/${staff.memberId}`).set(auth(owner.token)).send({ sections, ...(role ? { role } : {}) }).expect(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    const r = await request(http).post('/api/v1/auth/register').send({ email: owner.email, password: 'sec-pass-12345', displayName: 'مالك الأقسام', companyName: 'شركة الأقسام' }).expect(201);
    owner.token = r.body.accessToken;
    owner.companyId = r.body.company.id;
    const s = await request(http).post('/api/v1/shop/stores').set(auth(owner.token)).send({ name: 'متجر الأقسام', slug: `sec-${RUN}`, country: 'YE', whatsapp: '777123456' }).expect(201);
    storeId = s.body.store.id;
    // الوحدات المختبرة مقفلة على المجانية — المتجر على «الأعمال»
    await upgradeStore(prisma, owner.companyId, storeId);
    const p = await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth(owner.token)).send({ name: 'ساعة', price: 10000, costPrice: 4000, qty: 5, live: true }).expect(201);
    productId = p.body.id;
    const m = await request(http).post('/api/v1/team/members').set(auth(owner.token))
      .send({ email: staff.email, displayName: 'موظف الطلبات', password: staff.password, role: 6, sections: ['orders'] }).expect(201);
    staff.memberId = m.body.id;
    await login();
  });

  afterAll(async () => {
    if (owner.companyId) await prisma.organization.delete({ where: { id: owner.companyId } }).catch(() => undefined);
    for (const e of [owner.email, staff.email]) await prisma.user.delete({ where: { email: e } }).catch(() => undefined);
    await app.close();
  });

  it('موظف الطلبات: يرى الطلبات ويُمنع من المنتجات والقسائم والتقارير والعملاء، برسالة واضحة', async () => {
    await request(http).get(`/api/v1/shop/stores/${storeId}/orders`).set(auth(staff.token)).expect(200);
    await request(http).get(`/api/v1/shop/stores/${storeId}/carts`).set(auth(staff.token)).expect(200);
    const denied = await request(http).get(`/api/v1/shop/stores/${storeId}/products`).set(auth(staff.token)).expect(403);
    expect(JSON.stringify(denied.body)).toContain('المنتجات');
    await request(http).get(`/api/v1/shop/stores/${storeId}/coupons`).set(auth(staff.token)).expect(403);
    await request(http).get(`/api/v1/shop/stores/${storeId}/analytics`).set(auth(staff.token)).expect(403);
    await request(http).get(`/api/v1/shop/stores/${storeId}/customers`).set(auth(staff.token)).expect(403);
    // لوحة البداية ومناطق التوصيل للدور وحده
    await request(http).get(`/api/v1/shop/stores/${storeId}/overview`).set(auth(staff.token)).expect(200);
    const ctx = await request(http).get('/api/v1/auth/context').set(auth(staff.token)).expect(200);
    expect(ctx.body.sections).toEqual(['orders']);
    const team = await request(http).get('/api/v1/team/members').set(auth(owner.token)).expect(200);
    expect(team.body.members.find((x: { id: string }) => x.id === staff.memberId).sections).toEqual(['orders']);
    expect(team.body.members.find((x: { id: string }) => x.id !== staff.memberId).sections).toBeNull();
  });

  it('المنح يسري فورًا بلا دخول جديد، والتكلفة مخفية ولا يمحوها نموذج الموظف', async () => {
    await setSections(['orders', 'products']);
    const list = await request(http).get(`/api/v1/shop/stores/${storeId}/products`).set(auth(staff.token)).expect(200);
    expect(list.body.products[0].costPrice).toBeUndefined();
    const one = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth(staff.token)).expect(200);
    expect(one.body).not.toHaveProperty('costPrice');
    await request(http).patch(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth(staff.token)).send({ price: 11000, costPrice: 0 }).expect(200);
    const mine = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth(owner.token)).expect(200);
    expect(mine.body.price).toBe(11000);
    expect(mine.body.costPrice).toBe(4000);
  });

  it('null يعيد كل الأقسام، والمدير يرى كل شيء أيًّا كانت قائمته', async () => {
    await setSections(null);
    const r = await request(http).get(`/api/v1/shop/stores/${storeId}/products/${productId}`).set(auth(staff.token)).expect(200);
    expect(r.body.costPrice).toBe(4000);
    await setSections(['orders'], 2);
    await request(http).get(`/api/v1/shop/stores/${storeId}/coupons`).set(auth(staff.token)).expect(200);
    await request(http).patch(`/api/v1/team/members/${staff.memberId}`).set(auth(owner.token)).send({ sections: ['hacking'] }).expect(400);
  });
});
