import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * عمليات المنصة: حسابات الدفع المعلنة، وطلبات «متجر بتصميم خاص»، وصندوق
 * تنبيهات الفريق، وأجهزة الإشعارات، وجلسة الدعم التي يدير بها الفريق أي متجر،
 * وتغيير القالب من لوحة المنصة.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('عمليات المنصة', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const merchant = { email: `ops-m-${randomUUID()}@azm.test`, password: 'ops-merchant-1234', token: '', companyId: '', userId: '' };
  const staff = { email: `ops-s-${randomUUID()}@azm.test`, password: 'ops-staff-1234', token: '', companyId: '', userId: '' };
  let storeId = '';
  let savedAccounts: unknown = undefined;
  const leadIds: string[] = [];

  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const api = (p: string) => `/api/v1${p}`;

  async function register(u: typeof merchant, company: string) {
    const r = await request(http).post(api('/auth/register')).send({ email: u.email, password: u.password, displayName: company, companyName: company }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company?.id ?? r.body.companyId;
    u.userId = (await prisma.user.findUniqueOrThrow({ where: { email: u.email } })).id;
  }

  beforeAll(async () => {
    process.env.WEBHOOK_WORKER = '0';
    process.env.BILLING_WORKER = '0';
    process.env.NOTIFY_CHANNELS = 'console';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    savedAccounts = (await prisma.platformSetting.findUnique({ where: { key: 'pay.accounts' } }))?.value;
    await register(merchant, 'شركة التاجر');
    await register(staff, 'شركة الموظف');
    await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true, platformRole: 2 } });
    const slug = `ops-${randomUUID().slice(0, 8)}`;
    storeId = (await request(http).post(api('/shop/stores')).set(as(merchant.token)).send({ name: 'متجر العمليات', slug, sector: 'fashion', country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
  });

  afterAll(async () => {
    if (savedAccounts === undefined) await prisma.platformSetting.deleteMany({ where: { key: 'pay.accounts' } });
    else await prisma.platformSetting.update({ where: { key: 'pay.accounts' }, data: { value: savedAccounts as never } });
    await prisma.platformLead.deleteMany({ where: { id: { in: leadIds } } });
    for (const id of leadIds) await prisma.platformAlert.deleteMany({ where: { data: { path: ['leadId'], equals: id } } });
    for (const u of [merchant, staff]) {
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
    }
    await app.close();
  });

  describe('حسابات الدفع', () => {
    it('عامة بلا جلسة: الكريمي بالريال والدولار، وجيب وجوالي برمز QR', async () => {
      await prisma.platformSetting.deleteMany({ where: { key: 'pay.accounts' } });
      const r = await request(http).get(api('/shop/public/payment-accounts')).expect(200);
      const ids = r.body.accounts.map((a: { id: string }) => a.id);
      expect(ids).toEqual(['kuraimi-yer', 'kuraimi-usd', 'jaib', 'jawali']);
      const yer = r.body.accounts[0];
      expect(yer).toMatchObject({ provider: 'kuraimi', providerName: 'بنك الكريمي', number: '3075249852', currency: 'YER', kind: 'bank' });
      expect(r.body.accounts[2].qr).toBe('/pay/jaib-qr.png');
    });

    it('الفريق يعدّلها: حساب معطّل يختفي من العام ويبقى في اللوحة', async () => {
      const r = await request(http)
        .patch(api('/platform/settings'))
        .set(as(staff.token))
        .send({ values: { 'pay.accounts': [
          { provider: 'kuraimi', title: 'حساب ريال', number: '111222333', currency: 'yer', holder: 'RVIOS' },
          { provider: 'jaib', number: '601762', enabled: false },
        ] } })
        .expect(200);
      expect(r.body.applied).toContain('pay.accounts');
      expect(r.body.accounts).toHaveLength(2);
      expect(r.body.accounts[0]).toMatchObject({ id: 'kuraimi-1', currency: 'YER', holder: 'RVIOS' });

      const pub = await request(http).get(api('/shop/public/payment-accounts')).expect(200);
      expect(pub.body.accounts.map((a: { number: string }) => a.number)).toEqual(['111222333']);
    });

    it('يرفض مزوّدًا مجهولًا ورابط QR غير آمن وحسابًا بلا رقم ولا رمز', async () => {
      for (const bad of [
        [{ provider: 'bitcoin', number: '1' }],
        [{ provider: 'jaib', number: '1', qr: 'javascript:alert(1)' }],
        [{ provider: 'jawali' }],
      ]) {
        await request(http).patch(api('/platform/settings')).set(as(staff.token)).send({ values: { 'pay.accounts': bad } }).expect(400);
      }
    });

    it('التاجر لا يعدّل إعدادات المنصة', async () => {
      await request(http).patch(api('/platform/settings')).set(as(merchant.token)).send({ values: { 'pay.accounts': null } }).expect(403);
    });
  });

  describe('متجر بتصميم خاص', () => {
    it('زائر يرسل طلبًا فيصل الفريق تنبيه ويظهر في «طلبات التصميم»', async () => {
      const r = await request(http)
        .post(api('/shop/public/custom-store'))
        .send({
          name: 'سارة', phone: '+967 777 123 456', email: '', business: 'عطور', storeName: 'عطر الصباح',
          budget: 'growth', timeline: 'month', features: ['حجز مواعيد', 'برنامج ولاء'], styles: ['luxury'],
          references: ['https://example.com/store'], message: 'أريد متجرًا فخمًا بهوية ذهبية',
        })
        .expect(201);
      expect(r.body.ok).toBe(true);
      leadIds.push(r.body.id);

      const lead = await prisma.platformLead.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(lead).toMatchObject({ phone: '967777123456', status: 'new', budget: 'growth' });
      expect(lead.details).toMatchObject({ storeName: 'عطر الصباح', features: ['حجز مواعيد', 'برنامج ولاء'] });

      const alert = await prisma.platformAlert.findFirst({ where: { kind: 'custom_store', link: `/platform/leads?id=${lead.id}` } });
      expect(alert?.title).toContain('سارة');

      const list = await request(http).get(api('/platform/leads')).set(as(staff.token)).expect(200);
      expect(list.body.items.some((l: { id: string; ipHash?: string }) => l.id === lead.id && l.ipHash === undefined)).toBe(true);

      const upd = await request(http).patch(api(`/platform/leads/${lead.id}`)).set(as(staff.token)).send({ status: 'contacted', notes: 'اتصلنا بها' }).expect(200);
      expect(upd.body).toMatchObject({ status: 'contacted', notes: 'اتصلنا بها', handledBy: staff.userId });
    });

    it('الحقل الفخّ يُجاب بنجاح صامت ولا يُحفظ شيء', async () => {
      const before = await prisma.platformLead.count();
      const r = await request(http).post(api('/shop/public/custom-store')).send({ name: 'روبوت', phone: '777123456', website: 'http://spam' }).expect(201);
      expect(r.body).toEqual({ ok: true });
      expect(await prisma.platformLead.count()).toBe(before);
    });

    it('رقم غير صالح يُرفض، والتاجر لا يرى طلبات المنصة', async () => {
      await request(http).post(api('/shop/public/custom-store')).send({ name: 'خالد', phone: 'abc' }).expect(400);
      await request(http).get(api('/platform/leads')).set(as(merchant.token)).expect(403);
    });
  });

  describe('صندوق التنبيهات والأجهزة', () => {
    it('الفريق يقرأ التنبيهات ويعلّمها مقروءة للجميع', async () => {
      const c = await request(http).get(api('/platform/alerts/count')).set(as(staff.token)).expect(200);
      expect(c.body.unread).toBeGreaterThan(0);
      const list = await request(http).get(api('/platform/alerts?unread=1')).set(as(staff.token)).expect(200);
      const first = list.body.items[0];
      await request(http).patch(api(`/platform/alerts/${first.id}/read`)).set(as(staff.token)).expect(200);
      const row = await prisma.platformAlert.findUniqueOrThrow({ where: { id: first.id } });
      expect(row.readById).toBe(staff.userId);
      await request(http).get(api('/platform/alerts')).set(as(merchant.token)).expect(403);
    });

    it('جهاز التاجر يُسجَّل بشركته، وجهاز الفريق بتطبيق RVOS، والرمز نفسه ينتقل', async () => {
      const token = `fcm-${randomUUID()}-${randomUUID()}`;
      await request(http).post(api('/notify/devices')).set(as(merchant.token)).send({ token, platform: 'android' }).expect(201);
      let d = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
      expect(d).toMatchObject({ userId: merchant.userId, app: 'azm', companyId: merchant.companyId });

      await request(http).post(api('/platform/devices')).set(as(staff.token)).send({ token, platform: 'ios' }).expect(201);
      d = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
      expect(d).toMatchObject({ userId: staff.userId, app: 'rvos', platform: 'ios' });

      await request(http).delete(api(`/platform/devices/${token}`)).set(as(staff.token)).expect(200);
      expect(await prisma.deviceToken.count({ where: { token } })).toBe(0);
    });
  });

  describe('إدارة المتجر من لوحة المنصة', () => {
    it('بطاقة المتجر الكاملة وتغيير القالب المدفوع يمنحه للمتجر', async () => {
      const o = await request(http).get(api(`/platform/shop-stores/${storeId}/overview`)).set(as(staff.token)).expect(200);
      expect(o.body.store.id).toBe(storeId);
      expect(o.body.owner.email).toBe(merchant.email);
      expect(o.body.counts).toMatchObject({ products: 0, orders: 0 });

      const paid = (o.body.templates as Array<{ id: string; tier: string }>).find((t) => t.tier !== 'free')!;
      const r = await request(http).patch(api(`/platform/shop-stores/${storeId}/template`)).set(as(staff.token)).send({ template: paid.id }).expect(200);
      expect(r.body.template).toBe(paid.id);
      expect(r.body.ownedTemplates).toContain(paid.id);
      await request(http).patch(api(`/platform/shop-stores/${storeId}/template`)).set(as(staff.token)).send({ template: 'nope' }).expect(400);
      await request(http).patch(api(`/platform/shop-stores/${storeId}/template`)).set(as(merchant.token)).send({ template: 'essential' }).expect(403);
    });

    it('جلسة الدعم: الموظف يدير متجر الشركة بأدواتها، وتُسجَّل في سجل نشاطها', async () => {
      const s = await request(http).post(api(`/platform/shop-stores/${storeId}/support-session`)).set(as(staff.token)).expect(201);
      expect(s.body.company.id).toBe(merchant.companyId);
      const support = s.body.accessToken as string;

      const ctx = await request(http).get(api('/auth/context')).set(as(support)).expect(200);
      expect(ctx.body).toMatchObject({ support: true, company: { id: merchant.companyId } });

      await request(http).patch(api(`/shop/stores/${storeId}`)).set(as(support)).send({ tagline: 'عدّله فريق RVIOS' }).expect(200);
      const store = await prisma.shopStore.findUniqueOrThrow({ where: { id: storeId } });
      expect(store.tagline).toBe('عدّله فريق RVIOS');

      const log = await prisma.auditLog.findFirst({ where: { companyId: merchant.companyId, action: 'support.session', actorId: staff.userId } });
      expect(log?.description).toContain('متجر');
    });

    it('جلسة الدعم تسقط فور سحب صلاحية الموظف، ولا يصدرها غير الفريق', async () => {
      await request(http).post(api(`/platform/shop-stores/${storeId}/support-session`)).set(as(merchant.token)).expect(403);
      const s = await request(http).post(api(`/platform/shop-stores/${storeId}/support-session`)).set(as(staff.token)).expect(201);
      await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: false } });
      await request(http).get(api('/auth/context')).set(as(s.body.accessToken)).expect(403);
      await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true } });
    });
  });
});
