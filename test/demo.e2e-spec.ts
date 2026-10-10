import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { DEMO_EMAIL, DEMO_WORKSPACE_SLUG } from '../src/modules/demo/demo.constant';

/**
 * العرض التجريبي
 *
 * يثبت: الدخول بلا كلمة مرور يعطي جلسة لشركة العرض، والقراءة تعمل، وكل كتابة
 * تُرفض (403) أيًّا كان المسار، ومتجر العرض لا يقبل طلبات الزوّار.
 *
 * يستعمل شركة العرض إن كانت مهيّأة (`npm run demo:seed`)، وإلا ينشئ واحدة صغرى ويحذفها.
 */
describe('العرض التجريبي', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  let created: { orgId: string; userId: string; storeId: string } | null = null;
  let token = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    const existing = await prisma.organization.findUnique({ where: { workspaceSlug: DEMO_WORKSPACE_SLUG } });
    if (!existing) {
      const org = await prisma.organization.create({
        data: { syncId: randomUUID(), companyCode: `DEMO-${randomUUID().slice(0, 6)}`, workspaceSlug: DEMO_WORKSPACE_SLUG, name: 'شركة العرض' },
      });
      const user = await prisma.user.create({ data: { syncId: randomUUID(), email: DEMO_EMAIL, passwordHash: 'x', displayName: 'العرض' } });
      await prisma.membership.create({ data: { syncId: randomUUID(), userId: user.id, organizationId: org.id, role: 0, isActive: true } });
      const store = await prisma.shopStore.create({ data: { companyId: org.id, slug: `demo-${randomUUID().slice(0, 8)}`, name: 'متجر العرض', whatsapp: '966500000000' } });
      created = { orgId: org.id, userId: user.id, storeId: store.id };
    }
  });

  afterAll(async () => {
    if (created) {
      await prisma.shopStore.delete({ where: { id: created.storeId } }).catch(() => undefined);
      await prisma.membership.deleteMany({ where: { organizationId: created.orgId } });
      await prisma.organization.delete({ where: { id: created.orgId } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: created.userId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('الدخول بلا كلمة مرور يعطي جلسة لشركة العرض', async () => {
    const r = await request(http).post('/api/v1/auth/demo').expect(200);
    expect(r.body.company.workspaceSlug).toBe(DEMO_WORKSPACE_SLUG);
    token = r.body.accessToken;
    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('القراءة تعمل وكل كتابة تُرفض', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await request(http).get('/api/v1/clients').set(auth).expect(200);
    await request(http).get('/api/v1/shop/stores').set(auth).expect(200);
    const r = await request(http).post('/api/v1/clients').set(auth).send({ name: 'عميل' }).expect(403);
    expect(r.body.message).toContain('للمشاهدة فقط');
    await request(http).patch('/api/v1/me/profile').set(auth).send({ displayName: 'تعديل' }).expect(403);
    await request(http).post('/api/v1/me/password').set(auth).send({ currentPassword: 'x', newPassword: 'yyyyyyyy' }).expect(403);
  });

  it('متجر العرض لا يقبل طلبات الزوّار', async () => {
    const org = await prisma.organization.findUnique({ where: { workspaceSlug: DEMO_WORKSPACE_SLUG } });
    const store = await prisma.shopStore.findFirst({ where: { companyId: org!.id } });
    const product = await prisma.shopProduct.findFirst({ where: { storeId: store!.id } });
    const lines = [{ id: product?.id ?? randomUUID(), qty: 1 }];
    const r = await request(http).post(`/api/v1/shop/storefront/${store!.slug}/orders`).send({ lines, name: 'زائر', phone: '966500000000', address: 'الرياض' });
    expect(r.status).toBe(403);
  });
});
