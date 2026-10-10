import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * AZM — إدارة المنصة: الاستثناء المتعمَّد لا الثغرة
 *
 * `tenant-isolation.e2e-spec.ts` يثبت أن شركة لا ترى شركة أخرى. هذا
 * الملف يثبت العكس تمامًا على مسارات `@PlatformOnly()` فقط: موظف
 * المنصة **يجب** أن يرى كل الشركات معًا — وأي مستخدم عادي، مهما علت
 * صلاحيته داخل شركته، يُمنع بالكامل.
 *
 * ⚠ يتطلّب قاعدة تعمل، نفس متطلبات `tenant-isolation.e2e-spec.ts`.
 */
describe('إدارة المنصة — عبر كل الشركات', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const owner = {
    email: `owner-${randomUUID()}@azm.test`,
    password: 'owner-pass-1234',
    displayName: 'مالك عادي',
    companyName: 'شركة عادية',
    token: '',
    companyId: '',
    userId: '',
  };

  const staff = {
    email: `staff-${randomUUID()}@azm.test`,
    password: 'staff-pass-1234',
    displayName: 'موظفة منصة',
    companyName: 'حساب موظفة المنصة', // يُنشأ حسابها بنفس مسار التسجيل العادي
    token: '',
    userId: '',
  };

  let alphaOrgId = '';
  let betaOrgId = '';
  let invoiceId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
  });

  afterAll(async () => {
    for (const id of [alphaOrgId, betaOrgId].filter(Boolean)) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    for (const email of [owner.email, staff.email]) {
      await prisma.user.delete({ where: { email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('تُنشأ شركتان ومستخدم منصة، عبر التسجيل العادي', async () => {
    const a = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: owner.email, password: owner.password, displayName: owner.displayName, companyName: owner.companyName })
      .expect(201);
    owner.token = a.body.accessToken;
    owner.companyId = a.body.company.id;
    owner.userId = a.body.user.id;
    alphaOrgId = owner.companyId;

    const b = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: staff.email, password: staff.password, displayName: staff.displayName, companyName: staff.companyName })
      .expect(201);
    staff.token = b.body.accessToken;
    staff.userId = b.body.user.id;
    betaOrgId = b.body.company.id;
  });

  describe('قبل منح صلاحية المنصة', () => {
    it('مالك شركة عادية يُرفض من مسارات المنصة رغم كونه مالك شركته', async () => {
      await request(http)
        .get('/api/v1/platform/organizations')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(403);
    });

    it('حتى المستخدم المرشَّح ليكون موظف منصة يُرفض قبل المنح الفعلي', async () => {
      await request(http)
        .get('/api/v1/platform/me')
        .set('Authorization', `Bearer ${staff.token}`)
        .expect(403);
    });
  });

  describe('بعد المنح — نفس الآلية التي يستخدمها grant-platform-staff.ts', () => {
    beforeAll(async () => {
      await prisma.user.update({
        where: { id: staff.userId },
        data: { isPlatformStaff: true, platformRole: 2 },
      });
    });

    it('/platform/me يعيد هوية موظف المنصة لا شركته', async () => {
      const res = await request(http)
        .get('/api/v1/platform/me')
        .set('Authorization', `Bearer ${staff.token}`)
        .expect(200);

      expect(res.body.userId).toBe(staff.userId);
      expect(res.body.platformRole).toBe(2);
      // لا companyId هنا أصلًا — PlatformContext لا يحمل واحدًا
      expect(res.body.companyId).toBeUndefined();
    });

    it('يرى شركتين مختلفتين معًا في نفس القائمة', async () => {
      const res = await request(http)
        .get('/api/v1/platform/organizations')
        .set('Authorization', `Bearer ${staff.token}`)
        .expect(200);

      const ids = res.body.map((o: { id: string }) => o.id);
      expect(ids).toContain(alphaOrgId);
      expect(ids).toContain(betaOrgId);
    });

    it('لوحة تحكّمها تعمل رغم أن شركتها هي نفسها موضع الاستعراض — بلا خلط', async () => {
      // موظفة المنصة نفسها مالكة شركة betaOrgId من التسجيل — نتأكّد أن
      // مسار المنصة لا يُقيَّدها بشركتها هي فقط.
      const res = await request(http)
        .get(`/api/v1/platform/organizations/${alphaOrgId}`)
        .set('Authorization', `Bearer ${staff.token}`)
        .expect(200);

      expect(res.body.id).toBe(alphaOrgId);
      expect(res.body.name).toBe(owner.companyName);
    });

    it('تعدّل خطة شركة ألفا رغم عدم عضويتها فيها', async () => {
      const res = await request(http)
        .patch(`/api/v1/platform/organizations/${alphaOrgId}`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ planType: 2, subscriptionStatus: 0 })
        .expect(200);

      expect(res.body.planType).toBe(2);
    });

    it('مالك ألفا نفسه لا يستطيع فعل الشيء نفسه', async () => {
      await request(http)
        .patch(`/api/v1/platform/organizations/${alphaOrgId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ planType: 3 })
        .expect(403);
    });
  });

  describe('فواتير الاشتراك اليدوية', () => {
    it('تُنشئ فاتورة لشركة ألفا، والرقم يبدأ PINV-', async () => {
      const res = await request(http)
        .post('/api/v1/platform/invoices')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({
          companyId: alphaOrgId,
          amount: 499,
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
        })
        .expect(201);

      invoiceId = res.body.id;
      expect(res.body.invoiceNumber).toMatch(/^PINV-\d{6}$/);
      expect(res.body.status).toBe(0);
    });

    it('تُراجَع وتُسجَّل كمدفوعة، والمراجِع من الجلسة لا من الجسم', async () => {
      const res = await request(http)
        .patch(`/api/v1/platform/invoices/${invoiceId}/review`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ decision: 'paid', paymentReference: 'TRX-778899' })
        .expect(200);

      expect(res.body.status).toBe(2);
      expect(res.body.reviewedBy).toBe(staff.userId);
      expect(res.body.paymentReference).toBe('TRX-778899');
    });

    it('مالك ألفا لا يستطيع مراجعة فواتيره بنفسه', async () => {
      await request(http)
        .patch(`/api/v1/platform/invoices/${invoiceId}/review`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ decision: 'paid' })
        .expect(403);
    });
  });
});
