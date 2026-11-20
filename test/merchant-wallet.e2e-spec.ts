import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

type U = { email: string; token: string; companyId: string; userId: string };

/** محفظة التاجر لدى RVIOS: الشحن بعد التأكيد، الدفع منها فورًا، التجربة مرة، ومكافأة الإحالة مرة. */
describe('محفظة التاجر والتجربة والإحالات', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const mk = (n: string): U => ({ email: `wallet-${n}-${randomUUID()}@azm.test`, token: '', companyId: '', userId: '' });
  const a = mk('a');
  const b = mk('b');
  const staff = mk('staff');
  let storeB = '';
  let code = '';
  let cfg: { trialDays: number; trialPlan: string; referralPercent: number; periods: number[]; plans: Record<string, { prices: Record<string, number> }> };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const register = async (u: U, ref?: string) => {
    const r = await request(http).post('/api/v1/auth/register').send({ email: u.email, password: 'wallet-pass-12345', displayName: 'تاجر', companyName: 'شركة المحفظة', ...(ref ? { ref } : {}) }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    u.userId = r.body.user.id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    await register(a);
    await register(staff);
    await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true, platformRole: 2 } });
    cfg = (await request(http).get('/api/v1/billing/plans').set(auth(a.token)).expect(200)).body;
  });

  afterAll(async () => {
    for (const u of [a, b, staff]) {
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('لكل حساب رمز إحالة ثابت ورابط تسجيل، والمحفظة فارغة', async () => {
    const w = await request(http).get('/api/v1/shop/wallet').set(auth(a.token)).expect(200);
    code = w.body.referral.code;
    expect(code).toMatch(/^RV[A-Z0-9]{6}$/);
    expect(w.body.referral.link).toContain(`ref=${code}`);
    expect(w.body.balance).toBe(0);
    const again = await request(http).get('/api/v1/shop/wallet').set(auth(a.token)).expect(200);
    expect(again.body.referral.code).toBe(code);
  });

  it('التسجيل برمز الإحالة يربط الحساب بداعيه، والتجربة مرة واحدة', async () => {
    await register(b, code.toLowerCase());
    const org = await prisma.organization.findUnique({ where: { id: b.companyId } });
    expect(org?.referredById).toBe(a.companyId);

    const slug = `wallet-${randomUUID().slice(0, 8)}`;
    storeB = (await request(http).post('/api/v1/shop/stores').set(auth(b.token)).send({ name: 'متجر المحفظة', slug, country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    // متجر شركة أخرى لا يُجرَّب عليه
    await request(http).post('/api/v1/shop/billing/trial').set(auth(a.token)).send({ storeRef: storeB }).expect(404);

    const t = await request(http).post('/api/v1/shop/billing/trial').set(auth(b.token)).send({ storeRef: storeB }).expect(201);
    expect(t.body.trial).toBe(true);
    expect(t.body.effectivePlan).toBe(cfg.trialPlan);
    expect(t.body.daysLeft).toBe(cfg.trialDays);
    await request(http).post('/api/v1/shop/billing/trial').set(auth(b.token)).send({ storeRef: storeB }).expect(409);
    const w = await request(http).get('/api/v1/shop/wallet').set(auth(b.token)).expect(200);
    expect(w.body.trial.available).toBe(false);
  });

  it('الشحن لا يُضاف بالإيصال وحده بل بتأكيد الفريق', async () => {
    const inv = await request(http).post('/api/v1/shop/invoices').set(auth(b.token)).send({ storeRef: storeB, kind: 5, amount: 500000 }).expect(201);
    expect(Number(inv.body.amount)).toBe(500000);
    await request(http).post(`/api/v1/shop/invoices/${inv.body.id}/pay-wallet`).set(auth(b.token)).expect(400);
    await request(http).post(`/api/v1/shop/invoices/${inv.body.id}/proof`).set(auth(b.token)).send({ proofKey: 'https://example.com/r.jpg' }).expect(201);
    expect((await request(http).get('/api/v1/shop/wallet').set(auth(b.token)).expect(200)).body.balance).toBe(0);
    await request(http).patch(`/api/v1/platform/invoices/${inv.body.id}/review`).set(auth(staff.token)).send({ decision: 'paid' }).expect(200);
    // تأكيد ثانٍ لا يضاعف الشحن
    await request(http).patch(`/api/v1/platform/invoices/${inv.body.id}/review`).set(auth(staff.token)).send({ decision: 'paid' }).expect(200);
    const w = await request(http).get('/api/v1/shop/wallet').set(auth(b.token)).expect(200);
    expect(w.body.balance).toBe(500000);
    expect(w.body.txs[0]).toMatchObject({ kind: 'topup', amount: 500000, balance: 500000 });
  });

  it('الدفع من المحفظة يفعّل الباقة فورًا ويكافئ الداعي مرة واحدة', async () => {
    const months = cfg.periods[0];
    const price = cfg.plans.pro.prices[months];
    const inv = await request(http).post('/api/v1/shop/invoices').set(auth(b.token)).send({ storeRef: storeB, kind: 0, plan: 'pro', months }).expect(201);
    const paid = await request(http).post(`/api/v1/shop/invoices/${inv.body.id}/pay-wallet`).set(auth(b.token)).expect(201);
    expect(paid.body).toMatchObject({ status: 2, method: 'wallet' });
    await request(http).post(`/api/v1/shop/invoices/${inv.body.id}/pay-wallet`).set(auth(b.token)).expect(409);

    const sub = await request(http).get(`/api/v1/shop/subscriptions/${storeB}`).set(auth(b.token)).expect(200);
    expect(sub.body).toMatchObject({ plan: 'pro', trial: false });
    const wb = await request(http).get('/api/v1/shop/wallet').set(auth(b.token)).expect(200);
    expect(wb.body.balance).toBe(500000 - price);

    const reward = Math.floor((price * cfg.referralPercent) / 100);
    const wa = await request(http).get('/api/v1/shop/wallet').set(auth(a.token)).expect(200);
    expect(wa.body.balance).toBe(reward);
    expect(wa.body.referral).toMatchObject({ invited: 1, rewarded: 1, pending: 0, earned: reward });

    // اشتراك ثانٍ للمدعوّ لا يكافئ مرة أخرى
    const inv2 = await request(http).post('/api/v1/shop/invoices').set(auth(b.token)).send({ storeRef: storeB, kind: 0, plan: 'pro', months }).expect(201);
    if (500000 - price >= price) await request(http).post(`/api/v1/shop/invoices/${inv2.body.id}/pay-wallet`).set(auth(b.token)).expect(201);
    expect((await request(http).get('/api/v1/shop/wallet').set(auth(a.token)).expect(200)).body.balance).toBe(reward);
  });

  it('رصيد لا يكفي يُرفض والفاتورة تبقى بانتظار الدفع، وتعديل الفريق يُسجَّل', async () => {
    await prisma.organization.update({ where: { id: b.companyId }, data: { walletBalance: 10 } });
    const months = cfg.periods[cfg.periods.length - 1];
    const inv = await request(http).post('/api/v1/shop/invoices').set(auth(b.token)).send({ storeRef: storeB, kind: 0, plan: 'max', months }).expect(201);
    const r = await request(http).post(`/api/v1/shop/invoices/${inv.body.id}/pay-wallet`).set(auth(b.token)).expect(409);
    expect(JSON.stringify(r.body)).toContain('WALLET_LOW');
    const still = await prisma.platformInvoice.findUnique({ where: { id: inv.body.id } });
    expect(still?.status).toBe(0);

    await request(http).post(`/api/v1/platform/companies/${b.companyId}/wallet`).set(auth(b.token)).send({ amount: 1000 }).expect(403);
    const adj = await request(http).post(`/api/v1/platform/companies/${b.companyId}/wallet`).set(auth(staff.token)).send({ amount: 2500, note: 'تعويض' }).expect(201);
    expect(adj.body.balance).toBe(2510);
    expect(adj.body.txs[0]).toMatchObject({ kind: 'adjust', amount: 2500, note: 'تعويض' });
  });
});
