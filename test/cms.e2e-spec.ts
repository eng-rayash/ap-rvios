import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { SITE_WORKSPACE_SLUG } from '../src/modules/cms/site-organization.constant';

/**
 * AZM — محتوى الموقع الرئيسي
 *
 * الموقع منظمة محجوزة كأي شركة أخرى — لا مسار حماية موازٍ. هذا الملف
 * يثبت ثلاثة أشياء: العزل يعمل هنا كأي مستأجر آخر (شركة عادية لا ترى
 * محتوى الموقع)، البنود المتداخلة (المعرض/المؤشرات/الخدمات) تُستبدَل
 * كليًا لا تُدمَج، ونموذج التواصل العام يعمل بلا مصادقة ويكتب في
 * المنظمة الصحيحة وحدها.
 *
 * ⚠ يتطلّب قاعدة تعمل، نفس متطلبات بقية اختبارات e2e.
 */
describe('محتوى الموقع الرئيسي (CMS)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  let siteOrgId = '';
  let editorToken = '';
  let editorUserId = '';

  const outsider = {
    email: `outsider-${randomUUID()}@azm.test`,
    password: 'outsider-pass-1234',
    displayName: 'شركة أخرى',
    companyName: 'شركة لا صلة لها بالموقع',
    token: '',
  };

  let categoryId = '';
  let postId = '';
  let serviceAId = '';
  let serviceBId = '';
  let projectId = '';
  let contactId = '';
  let settingId = '';
  let ownsOrg = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    // مالك تحرير للموقع — يُسجَّل بمسار التسجيل العادي، ثم تُنقَل
    // عضويته إلى منظمة الموقع المحجوزة (نفس ما يفعله سكربت التهيئة).
    const editorEmail = `editor-${randomUUID()}@azm.test`;
    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: editorEmail, password: 'editor-pass-1234', displayName: 'محرّرة الموقع', companyName: 'مساحة مؤقّتة' })
      .expect(201);
    editorUserId = reg.body.user.id;

    // ⚠ لا نحذف هذه المنظمة أبدًا إن كانت موجودة أصلًا — انظر تسويغ ذلك
    // في `afterAll`. حادثة حقيقية وقعت أثناء بناء هذا الملف: نسخة سابقة
    // منه حذفت منظمة الموقع الحقيقية لأنها بحثت بالمُعرِّف الثابت
    // ووجدتها فحذفتها في التنظيف — الملكية تُتتبَّع الآن صراحةً.
    let siteOrg = await prisma.organization.findUnique({ where: { workspaceSlug: SITE_WORKSPACE_SLUG } });
    if (!siteOrg) {
      siteOrg = await prisma.organization.create({
        data: {
          syncId: randomUUID(),
          companyCode: 'SITE-MAIN',
          workspaceSlug: SITE_WORKSPACE_SLUG,
          name: 'RVIOS — الموقع الرئيسي',
        },
      });
      ownsOrg = true;
    }
    siteOrgId = siteOrg.id;

    await prisma.membership.create({
      data: {
        syncId: randomUUID(),
        userId: editorUserId,
        organizationId: siteOrgId,
        role: 0,
        isActive: true,
        joinedAt: new Date(),
      },
    });

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    editorToken = await jwt.signAsync({ sub: editorUserId, companyId: siteOrgId });

    const out = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: outsider.email, password: outsider.password, displayName: outsider.displayName, companyName: outsider.companyName })
      .expect(201);
    outsider.token = out.body.accessToken;
  });

  afterAll(async () => {
    if (ownsOrg) {
      // أنشأناها نحن، فحذفها بالتبعية يُنظِّف كل شيء تحتها بأمان.
      await prisma.organization.delete({ where: { id: siteOrgId } }).catch(() => undefined);
    } else {
      // كانت موجودة أصلًا — نحذف فقط الصفوف التي أنشأناها نحن بمعرّفاتها
      // الدقيقة، ولا نلمس المنظمة نفسها أو أي محتوى آخر فيها. بهذا
      // الترتيب: الأبناء (الصور والمؤشرات وربط الخدمات) قبل الأصل.
      if (projectId) {
        await prisma.cmsProjectService.deleteMany({ where: { projectId } }).catch(() => undefined);
        await prisma.cmsProjectImage.deleteMany({ where: { projectId } }).catch(() => undefined);
        await prisma.cmsProjectMetric.deleteMany({ where: { projectId } }).catch(() => undefined);
        await prisma.cmsProject.delete({ where: { id: projectId } }).catch(() => undefined);
      }
      if (serviceAId) await prisma.cmsService.delete({ where: { id: serviceAId } }).catch(() => undefined);
      if (serviceBId) await prisma.cmsService.delete({ where: { id: serviceBId } }).catch(() => undefined);
      if (postId) await prisma.cmsPost.delete({ where: { id: postId } }).catch(() => undefined);
      if (categoryId) await prisma.cmsCategory.delete({ where: { id: categoryId } }).catch(() => undefined);
      if (contactId) await prisma.cmsContact.delete({ where: { id: contactId } }).catch(() => undefined);
      if (settingId) await prisma.cmsSetting.delete({ where: { id: settingId } }).catch(() => undefined);
      await prisma.membership
        .deleteMany({ where: { userId: editorUserId, organizationId: siteOrgId } })
        .catch(() => undefined);
    }
    await prisma.user.delete({ where: { id: editorUserId } }).catch(() => undefined);
    await prisma.user.delete({ where: { email: outsider.email } }).catch(() => undefined);
    await app.close();
  });

  describe('التصنيفات والمقالات', () => {
    it('تُنشئ تصنيفًا', async () => {
      const res = await request(http)
        .post('/api/v1/cms/categories')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ name: 'تقنية', nameEn: 'Technology', slug: 'technology' })
        .expect(201);
      categoryId = res.body.id;
      expect(res.body.companyId).toBe(siteOrgId);
    });

    it('تُنشئ مقالًا مسودة بلا تاريخ نشر', async () => {
      const res = await request(http)
        .post('/api/v1/cms/posts')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          title: 'مقال تجريبي',
          slug: 'test-post',
          description: 'وصف قصير',
          content: 'المحتوى الكامل هنا',
          metaDescription: 'وصف meta',
          categoryId,
        })
        .expect(201);
      postId = res.body.id;
      expect(res.body.status).toBe(0);
      expect(res.body.publishedAt).toBeNull();
    });

    it('النشر يختم publishedAt تلقائيًا', async () => {
      const res = await request(http)
        .patch(`/api/v1/cms/posts/${postId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ status: 1 })
        .expect(200);
      expect(res.body.status).toBe(1);
      expect(res.body.publishedAt).not.toBeNull();
    });

    it('شركة أخرى لا ترى تصنيف أو مقال الموقع', async () => {
      const res = await request(http)
        .get('/api/v1/cms/categories')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);
      expect(res.body.map((c: { id: string }) => c.id)).not.toContain(categoryId);

      await request(http)
        .get(`/api/v1/cms/posts/${postId}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });
  });

  describe('الخدمات والمشاريع المتداخلة', () => {
    it('تُنشئ خدمتين', async () => {
      const a = await request(http)
        .post('/api/v1/cms/services')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ title: 'تصميم', titleEn: 'Design', slug: 'design', description: 'وصف', descriptionEn: 'desc' })
        .expect(201);
      serviceAId = a.body.id;

      const b = await request(http)
        .post('/api/v1/cms/services')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ title: 'تطوير', titleEn: 'Development', slug: 'development', description: 'وصف', descriptionEn: 'desc' })
        .expect(201);
      serviceBId = b.body.id;
    });

    it('تُنشئ مشروعًا بمعرض ومؤشرات وخدمة مرتبطة واحدة', async () => {
      const res = await request(http)
        .post('/api/v1/cms/projects')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          slug: 'test-project',
          title: 'مشروع تجريبي',
          summary: 'سطر واحد',
          description: 'وصف كامل',
          serviceIds: [serviceAId],
          gallery: [{ url: 'https://x/1.jpg', order: 0 }, { url: 'https://x/2.jpg', order: 1 }],
          metrics: [{ label: 'زيادة التحويل', value: '32', unit: '٪' }],
        })
        .expect(201);

      projectId = res.body.id;
      expect(res.body.gallery).toHaveLength(2);
      expect(res.body.metrics).toHaveLength(1);
      expect(res.body.services.map((s: { serviceId: string }) => s.serviceId)).toEqual([serviceAId]);
    });

    it('تعديل المشروع باستبدال الخدمة المرتبطة يحذف القديمة لا يضيف إليها', async () => {
      const res = await request(http)
        .patch(`/api/v1/cms/projects/${projectId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ serviceIds: [serviceBId] })
        .expect(200);

      const linkedIds = res.body.services.map((s: { serviceId: string }) => s.serviceId);
      expect(linkedIds).toEqual([serviceBId]);
      expect(linkedIds).not.toContain(serviceAId);
    });

    it('تعديل حقل غير متعلّق بالمعرض لا يمسحه', async () => {
      const res = await request(http)
        .patch(`/api/v1/cms/projects/${projectId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ featured: true })
        .expect(200);

      expect(res.body.featured).toBe(true);
      expect(res.body.gallery).toHaveLength(2);
    });
  });

  describe('نموذج التواصل العام', () => {
    it('يُنشأ بلا رمز مصادقة، ويصل إلى منظمة الموقع تحديدًا', async () => {
      const res = await request(http)
        .post('/api/v1/cms/contacts/public')
        .send({ name: 'زائر', email: 'visitor@example.com', message: 'أريد الاستفسار عن خدماتكم' })
        .expect(201);

      expect(res.body.companyId).toBe(siteOrgId);
      contactId = res.body.id;

      const seen = await request(http)
        .get('/api/v1/cms/contacts')
        .set('Authorization', `Bearer ${editorToken}`)
        .expect(200);
      expect(seen.body.map((c: { id: string }) => c.id)).toContain(res.body.id);
    });

    it('يرفض حقلًا غير معلَن — لا يمكن لزائر انتحال companyId', async () => {
      await request(http)
        .post('/api/v1/cms/contacts/public')
        .send({ name: 'زائر', email: 'visitor@example.com', message: 'رسالة', companyId: 'x' })
        .expect(400);
    });

    it('يقبل رقم تواصل بلا بريد — طلبات خدمة منصة المتاجر تصل بواتساب وحده', async () => {
      const res = await request(http)
        .post('/api/v1/cms/contacts/public')
        .send({ name: 'زائر منصة المتاجر', phone: '966551234567', service: 'منصة المتاجر — دومين مخصص', message: 'دومين مخصص' })
        .expect(201);
      expect(res.body.email).toBeNull();
      expect(res.body.phone).toBe('966551234567');
    });

    it('يرفض رسالة بلا بريد ولا هاتف — لا وسيلة للرد عليها', async () => {
      await request(http)
        .post('/api/v1/cms/contacts/public')
        .send({ name: 'زائر', phone: '  ', message: 'رسالة' })
        .expect(400);
    });
  });

  describe('الإعدادات', () => {
    it('upsert يُنشئ ثم يحدّث بالمفتاح نفسه لا يكرّره', async () => {
      const first = await request(http)
        .post('/api/v1/cms/settings')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ key: 'site.tagline', value: 'منصّتك لبناء حضور رقمي' })
        .expect(201);

      const second = await request(http)
        .post('/api/v1/cms/settings')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ key: 'site.tagline', value: 'قيمة محدَّثة' })
        .expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.value).toBe('قيمة محدَّثة');
      settingId = second.body.id;
    });
  });
});
