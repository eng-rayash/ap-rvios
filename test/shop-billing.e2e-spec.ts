import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * AZM — فوترة منصة المتاجر
 *
 * يثبت: (١) دورة الاشتراك من فاتورة إلى تفعيل فوري إلى تراجع عند
 * الرفض، (٢) أن تاجرًا لا يرى فواتير غيره ولا اشتراكاته، (٣) أن
 * الأسعار غير المعلنة ترفض الفوترة بدل اختراع رقم، (٤) الكنس.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('فوترة منصة المتاجر', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'shop-pass-1234',
    displayName: label,
    companyName: `متجر ${label}`,
    token: '',
    companyId: '',
    userId: '',
  });
  const a = mk('alpha');
  const b = mk('beta');
  const staff = mk('staff');

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let invoiceId = '';
  let subId = '';
  const TEST_KEYS = [
    'price.plus',
    'price.pro',
    'price.store_build',
    'price.domain',
    'price.extra_store', 'billing.currency', 'app.minVersion', 'app.maintenance', 'app.maintenanceMessage', 'app.storeUrl'];
  let savedSettings: Array<{ key: string; value: unknown }> = [];

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({
        email: u.email,
        password: u.password,
        displayName: u.displayName,
        companyName: u.companyName,
      })
      .expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    u.userId = r.body.user.id;
  }

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

    // إعدادات المنصة عالمية: نحفظ ما كان موجودًا لنستعيده لا لنمسحه
    savedSettings = await prisma.platformSetting.findMany({
      where: { key: { in: TEST_KEYS } },
    });
    // نبدأ بأسعار غير معلنة — الاختبار يفترض ذلك (PRICE_UNSET)
    await prisma.platformSetting.deleteMany({ where: { key: { in: TEST_KEYS } } });

    await register(a);
    await register(b);
    await register(staff);
    await prisma.user.update({
      where: { id: staff.userId },
      data: { isPlatformStaff: true, platformRole: 2 },
    });
    // أسعار الاختبار — تُستعاد في afterAll
    await request(http)
      .patch('/api/v1/platform/settings')
      .set(auth(staff.token))
      .send({ values: { 'price.plus': 5000, 'price.pro': 15000 } })
      .expect(200);
  });

  afterAll(async () => {
    await prisma.platformSetting
      .deleteMany({ where: { key: { in: TEST_KEYS } } })
      .catch(() => undefined);
    for (const s of savedSettings) {
      await prisma.platformSetting
        .create({ data: { key: s.key, value: s.value as never } })
        .catch(() => undefined);
    }
    for (const u of [a, b, staff]) {
      if (u.companyId) {
        await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      }
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('اشتراك متجر جديد مجاني افتراضيًا', async () => {
    const res = await request(http)
      .put('/api/v1/shop/subscriptions/store-1')
      .set(auth(a.token))
      .send({ storeName: 'متجر ألفا' })
      .expect(200);
    expect(res.body.plan).toBe('basic');
    expect(res.body.effectivePlan).toBe('basic');
  });

  it('فاتورة بلس تحسب من السعر المعلن، والتكرار يعيد الفاتورة نفسها', async () => {
    const body = { storeRef: 'store-1', kind: 0, plan: 'plus', months: 1 };
    const r1 = await request(http)
      .post('/api/v1/shop/invoices')
      .set(auth(a.token))
      .send(body)
      .expect(201);
    invoiceId = r1.body.id;
    expect(r1.body.invoiceNumber).toMatch(/^RV-INV-\d{6}$/);
    expect(Number(r1.body.amount)).toBe(5000);
    expect(r1.body.currency).toBe('USD'); // عملة الفوترة الافتراضية

    const r2 = await request(http)
      .post('/api/v1/shop/invoices')
      .set(auth(a.token))
      .send(body)
      .expect(201);
    expect(r2.body.id).toBe(invoiceId);
  });

  it('السنوي يخصم الشهور المجانية (12 شهرًا = 10 مدفوعة)', async () => {
    // استبدال الفاتورة المفتوحة بأخرى مختلفة
    const r = await request(http)
      .post('/api/v1/shop/invoices')
      .set(auth(a.token))
      .send({ storeRef: 'store-1', kind: 0, plan: 'plus', months: 12 })
      .expect(201);
    expect(Number(r.body.amount)).toBe(50000);
    expect(r.body.id).not.toBe(invoiceId);
    invoiceId = r.body.id;

    // الفاتورة القديمة أُلغيت باستبدال
    const list = await request(http)
      .get('/api/v1/shop/invoices?storeRef=store-1')
      .set(auth(a.token))
      .expect(200);
    const voided = list.body.filter((i: { status: number }) => i.status === 3);
    expect(voided.length).toBe(1);
    expect(voided[0].voidReason).toBe('استُبدلت بطلب أحدث');
  });

  it('سعر خدمة غير معلن يرفض الفوترة بدل اختراع رقم', async () => {
    const r = await request(http)
      .post('/api/v1/shop/invoices')
      .set(auth(a.token))
      .send({ storeRef: 'store-1', kind: 2 })
      .expect(409);
    expect(JSON.stringify(r.body)).toContain('PRICE_UNSET');
  });

  it('رفع الإيصال يفعّل الباقة فورًا قبل المراجعة', async () => {
    const r = await request(http)
      .post(`/api/v1/shop/invoices/${invoiceId}/proof`)
      .set(auth(a.token))
      .send({ method: 'kuraimi', proofKey: 'uploads/stores/1/receipts/x.jpg' })
      .expect(201);
    expect(r.body.status).toBe(1);

    const sub = await request(http)
      .get('/api/v1/shop/subscriptions/store-1')
      .set(auth(a.token))
      .expect(200);
    expect(sub.body.plan).toBe('plus');
    expect(sub.body.effectivePlan).toBe('plus');
    expect(sub.body.daysLeft).toBeGreaterThan(300);
  });

  it('لا يمكن استبدال فاتورة قيد المراجعة بأخرى مختلفة', async () => {
    const r = await request(http)
      .post('/api/v1/shop/invoices')
      .set(auth(a.token))
      .send({ storeRef: 'store-1', kind: 0, plan: 'pro', months: 1 })
      .expect(409);
    expect(JSON.stringify(r.body)).toContain('INVOICE_PENDING');
  });

  describe('العزل بين التجار', () => {
    it('بيتا لا ترى فواتير ألفا', async () => {
      const res = await request(http)
        .get('/api/v1/shop/invoices')
        .set(auth(b.token))
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('بيتا لا تستطيع رفع إيصال على فاتورة ألفا', async () => {
      await request(http)
        .post(`/api/v1/shop/invoices/${invoiceId}/proof`)
        .set(auth(b.token))
        .send({ proofKey: 'x' })
        .expect(404);
    });

    it('المتجر نفسه بمعرّف متطابق عند بيتا اشتراكٌ منفصل ومجاني', async () => {
      const res = await request(http)
        .get('/api/v1/shop/subscriptions/store-1')
        .set(auth(b.token))
        .expect(200);
      expect(res.body.plan).toBe('basic');
    });

    it('تاجر عادي لا يصل إلى مسارات المنصة', async () => {
      await request(http)
        .get('/api/v1/platform/store-subscriptions')
        .set(auth(a.token))
        .expect(403);
      await request(http)
        .patch('/api/v1/platform/settings')
        .set(auth(a.token))
        .send({ values: { 'price.pro': 1 } })
        .expect(403);
    });
  });

  describe('إعدادات تطبيق عزم الجوال', () => {
    it('تُقرأ بلا مصادقة، وتضبطها المنصة وحدها بقيم مُتحقَّق منها', async () => {
      await request(http)
        .patch('/api/v1/platform/settings')
        .set(auth(staff.token))
        .send({ values: { 'app.minVersion': '1.2.0', 'app.maintenance': true, 'app.maintenanceMessage': 'صيانة قصيرة', 'app.storeUrl': 'https://play.google.com/store/apps/details?id=azm' } })
        .expect(200);

      const r = await request(http).get('/api/v1/app/config').expect(200);
      expect(r.body).toMatchObject({ minVersion: '1.2.0', maintenance: true, maintenanceMessage: 'صيانة قصيرة' });
      expect(r.body.storeUrl).toContain('https://play.google.com');

      await request(http)
        .patch('/api/v1/platform/settings')
        .set(auth(staff.token))
        .send({ values: { 'app.minVersion': 'latest' } })
        .expect(400);
      await request(http)
        .patch('/api/v1/platform/settings')
        .set(auth(staff.token))
        .send({ values: { 'app.storeUrl': 'javascript:alert(1)' } })
        .expect(400);
      await request(http)
        .patch('/api/v1/platform/settings')
        .set(auth(a.token))
        .send({ values: { 'app.maintenance': false } })
        .expect(403);
    });
  });

  describe('مراجعة الإدارة', () => {
    it('الموظف يرى اشتراك ألفا وبيتا معًا', async () => {
      const res = await request(http)
        .get('/api/v1/platform/store-subscriptions')
        .set(auth(staff.token))
        .expect(200);
      const companies = res.body.subscriptions.map((s: { companyId: string }) => s.companyId);
      expect(companies).toContain(a.companyId);
      expect(companies).toContain(b.companyId);
      subId = res.body.subscriptions.find(
        (s: { companyId: string; plan: number }) => s.companyId === a.companyId && s.plan === 1,
      ).id;
    });

    it('رفض إيصال فُعِّل مسبقًا يسحب الباقة', async () => {
      await request(http)
        .patch(`/api/v1/platform/invoices/${invoiceId}/review`)
        .set(auth(staff.token))
        .send({ decision: 'rejected', reason: 'إيصال غير مطابق' })
        .expect(200);

      const sub = await request(http)
        .get('/api/v1/shop/subscriptions/store-1')
        .set(auth(a.token))
        .expect(200);
      expect(sub.body.plan).toBe('basic');
      expect(sub.body.status).toBe(2);
    });

    it('اعتماد فاتورة يدويًا بلا إيصال يفعّل الباقة', async () => {
      const inv = await request(http)
        .post('/api/v1/shop/invoices')
        .set(auth(a.token))
        .send({ storeRef: 'store-1', kind: 0, plan: 'pro', months: 1 })
        .expect(201);
      await request(http)
        .patch(`/api/v1/platform/invoices/${inv.body.id}/review`)
        .set(auth(staff.token))
        .send({ decision: 'paid', paymentReference: 'TRX-1' })
        .expect(200);

      const sub = await request(http)
        .get('/api/v1/shop/subscriptions/store-1')
        .set(auth(a.token))
        .expect(200);
      expect(sub.body.plan).toBe('pro');
      expect(sub.body.status).toBe(0);
    });
  });

  describe('الكنس والمهلة', () => {
    it('اشتراك منتهي الفترة ينتقل إلى مهلة ثم منتهٍ بلا حذف', async () => {
      const sub = await prisma.storeSubscription.findFirst({
        where: { companyId: a.companyId, storeRef: 'store-1' },
      });
      // فترة انتهت قبل يومين ← مهلة
      await prisma.storeSubscription.update({
        where: { id: sub!.id },
        data: { currentPeriodEnd: new Date(Date.now() - 2 * 86_400_000) },
      });
      const r1 = await request(http)
        .post('/api/v1/platform/store-subscriptions/sweep')
        .set(auth(staff.token))
        .expect(201);
      expect(r1.body.toGrace.map((s: { id: string }) => s.id)).toContain(sub!.id);
      let now = await prisma.storeSubscription.findUnique({ where: { id: sub!.id } });
      expect(now!.status).toBe(1);
      expect(now!.plan).toBe(2); // الباقة باقية في المهلة

      // انتهت قبل عشرة أيام ← منتهٍ، ويعود مؤثّرًا إلى المجانية
      await prisma.storeSubscription.update({
        where: { id: sub!.id },
        data: { currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000) },
      });
      await request(http)
        .post('/api/v1/platform/store-subscriptions/sweep')
        .set(auth(staff.token))
        .expect(201);
      now = await prisma.storeSubscription.findUnique({ where: { id: sub!.id } });
      expect(now!.status).toBe(2);

      const view = await request(http)
        .get('/api/v1/shop/subscriptions/store-1')
        .set(auth(a.token))
        .expect(200);
      expect(view.body.effectivePlan).toBe('basic');
    });

    it('تذكير قبل 7 أيام يظهر مرة، ولا يتكرر بعد التأكيد', async () => {
      const sub = await prisma.storeSubscription.findFirst({
        where: { companyId: a.companyId, storeRef: 'store-1' },
      });
      await prisma.storeSubscription.update({
        where: { id: sub!.id },
        data: {
          plan: 2,
          status: 0,
          notifiedStage: null,
          currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
        },
      });
      const r1 = await request(http)
        .post('/api/v1/platform/store-subscriptions/sweep')
        .set(auth(staff.token))
        .expect(201);
      const mine = r1.body.reminders.filter((x: { id: string }) => x.id === sub!.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].stage).toBe('d7');

      await request(http)
        .post(`/api/v1/platform/store-subscriptions/${sub!.id}/notified`)
        .set(auth(staff.token))
        .send({ stage: 'd7' })
        .expect(201);

      const r2 = await request(http)
        .post('/api/v1/platform/store-subscriptions/sweep')
        .set(auth(staff.token))
        .expect(201);
      expect(r2.body.reminders.filter((x: { id: string }) => x.id === sub!.id)).toHaveLength(0);
    });
  });

  describe('خانات المتاجر', () => {
    it('المتجر الإضافي يتطلب برو فعّالة', async () => {
      await request(http)
        .patch('/api/v1/platform/settings')
        .set(auth(staff.token))
        .send({ values: { 'price.extra_store': 3000 } })
        .expect(200);

      // بيتا مجانية ← مرفوض
      const r = await request(http)
        .post('/api/v1/shop/invoices')
        .set(auth(b.token))
        .send({ storeRef: 'store-1', kind: 3 })
        .expect(409);
      expect(JSON.stringify(r.body)).toContain('PRO_REQUIRED');
    });

    it('دفع فاتورة متجر إضافي (ألفا برو) يمنح خانة، ورفضها يسحبها', async () => {
      // ألفا برو نشطة (ضُبطت في اختبار التذكير)
      const inv = await request(http)
        .post('/api/v1/shop/invoices')
        .set(auth(a.token))
        .send({ storeRef: 'store-1', kind: 3 })
        .expect(201);
      await request(http)
        .post(`/api/v1/shop/invoices/${inv.body.id}/proof`)
        .set(auth(a.token))
        .send({ method: 'jaib', proofKey: 'k' })
        .expect(201);
      let slots = await request(http).get('/api/v1/shop/billing/slots').set(auth(a.token)).expect(200);
      expect(slots.body.slots).toBe(2);

      await request(http)
        .patch(`/api/v1/platform/invoices/${inv.body.id}/review`)
        .set(auth(staff.token))
        .send({ decision: 'rejected' })
        .expect(200);
      slots = await request(http).get('/api/v1/shop/billing/slots').set(auth(a.token)).expect(200);
      // لا ينزل تحت عدد الاشتراكات المسجَّلة (1) ولا تحت 1
      expect(slots.body.slots).toBe(1);
    });
  });

  describe('التسعير العام والوراثة وحذف الاشتراك', () => {
    it('الأسعار المعلنة تُقرأ بلا جلسة، ووسائل الدفع لا', async () => {
      const pub = await request(http).get('/api/v1/shop/public/pricing').expect(200);
      expect(pub.body.prices).toBeDefined();
      expect(pub.body.methods).toBeUndefined();
    });

    it('متجر إضافي يرث باقة الحساب من متجر آخر في الشركة نفسها فقط', async () => {
      // ألفا: store-1 على برو من اختبار سابق؛ نضمن ذلك صراحةً
      const sub = await prisma.storeSubscription.findFirst({
        where: { companyId: a.companyId, storeRef: 'store-1' },
      });
      await prisma.storeSubscription.update({
        where: { id: sub!.id },
        data: { plan: 2, status: 0, currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000) },
      });
      const r = await request(http)
        .post('/api/v1/shop/subscriptions/store-2/inherit/store-1')
        .set(auth(a.token))
        .expect(201);
      expect(r.body.plan).toBe('pro');
      expect(r.body.daysLeft).toBeGreaterThan(30);

      // بيتا لا تملك store-1 بباقة — المصدر من شركتها هي (مجانية)، فلا ترث شيئًا
      const other = await request(http)
        .post('/api/v1/shop/subscriptions/store-9/inherit/store-1')
        .set(auth(b.token))
        .expect(201);
      expect(other.body.plan).toBe('basic');
    });

    it('حذف الاشتراك لا يترك يتيمًا، والمعرّف العائد يبدأ نظيفًا', async () => {
      await request(http)
        .delete('/api/v1/shop/subscriptions/store-2')
        .set(auth(a.token))
        .expect(200);
      const listed = await request(http)
        .get('/api/v1/platform/store-subscriptions')
        .set(auth(staff.token))
        .expect(200);
      expect(
        listed.body.subscriptions.some(
          (x: { companyId: string; storeRef: string }) =>
            x.companyId === a.companyId && x.storeRef === 'store-2',
        ),
      ).toBe(false);

      const back = await request(http)
        .put('/api/v1/shop/subscriptions/store-2')
        .set(auth(a.token))
        .send({ storeName: 'عائد' })
        .expect(200);
      expect(back.body.plan).toBe('basic');
    });

    it('فريق المنصة يصحّح خانات الحساب، ومالكه لا يستطيع', async () => {
      await request(http)
        .patch(`/api/v1/platform/organizations/${a.companyId}`)
        .set(auth(staff.token))
        .send({ storeSlots: 3 })
        .expect(200);
      const slots = await request(http).get('/api/v1/shop/billing/slots').set(auth(a.token)).expect(200);
      expect(slots.body.slots).toBe(3);
      await request(http)
        .patch(`/api/v1/platform/organizations/${a.companyId}`)
        .set(auth(a.token))
        .send({ storeSlots: 5 })
        .expect(403);
    });
  });

  it('subId مستخدم (تحقّق أن التعديل اليدوي للاشتراك يعمل)', async () => {
    const res = await request(http)
      .patch(`/api/v1/platform/store-subscriptions/${subId}`)
      .set(auth(staff.token))
      .send({ extendDays: 30 })
      .expect(200);
    expect(new Date(res.body.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now());
  });
});
