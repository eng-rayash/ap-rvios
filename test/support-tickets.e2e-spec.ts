import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/** تذاكر الدعم: التاجر يفتح ويرد ويغلق تذاكر شركته وحدها، والفريق يرى الكل ويرد فتنتقل الحالة. */
describe('تذاكر الدعم', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const mk = (p: string) => ({ email: `${p}-${randomUUID()}@azm.test`, token: '', companyId: '', userId: '' });
  const merchant = mk('sup');
  const other = mk('sup2');
  const staff = mk('sup-staff');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    for (const x of [merchant, other, staff]) {
      const r = await request(http).post('/api/v1/auth/register').send({ email: x.email, password: 'sup-pass-12345', displayName: 'مستخدم الدعم', companyName: 'شركة الدعم' }).expect(201);
      x.token = r.body.accessToken; x.companyId = r.body.company.id; x.userId = r.body.user.id;
    }
    await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true, platformRole: 0 } });
  });

  afterAll(async () => {
    for (const x of [merchant, other, staff]) {
      if (x.companyId) await prisma.organization.delete({ where: { id: x.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: x.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('من الفتح حتى الإغلاق: الحالة تتبع من ينتظر من، والعزل بين الشركات', async () => {
    await request(http).post('/api/v1/support/tickets').set(auth(merchant.token)).send({ subject: 'x', category: 'store', body: 'قصير' }).expect(400);
    const t = await request(http).post('/api/v1/support/tickets').set(auth(merchant.token))
      .send({ subject: 'النطاق الخاص لا يعمل', category: 'domain', priority: 2, body: 'ربطت النطاق قبل يومين ولا يفتح المتجر عليه.' }).expect(201);
    expect(t.body.ref).toMatch(/^T-[0-9A-F]{6}$/);
    expect(t.body.status).toBe(0);

    await request(http).get(`/api/v1/support/tickets/${t.body.id}`).set(auth(other.token)).expect(404);
    expect((await request(http).get('/api/v1/support/tickets').set(auth(other.token)).expect(200)).body).toHaveLength(0);
    await request(http).get('/api/v1/platform/support').set(auth(merchant.token)).expect(403);

    const list = await request(http).get('/api/v1/platform/support?status=0').set(auth(staff.token)).expect(200);
    expect(list.body.tickets.find((x: { id: string }) => x.id === t.body.id).organization.name).toBe('شركة الدعم');
    const r = await request(http).post(`/api/v1/platform/support/${t.body.id}/messages`).set(auth(staff.token)).send({ body: 'أضف سجل CNAME إلى store.rvios.com وانتظر ساعة.' }).expect(201);
    expect(r.body.status).toBe(1);
    expect(r.body.messages.map((m: { fromStaff: boolean }) => m.fromStaff)).toEqual([false, true]);

    const back = await request(http).post(`/api/v1/support/tickets/${t.body.id}/messages`).set(auth(merchant.token)).send({ body: 'تم، شكرًا — يعمل الآن.' }).expect(201);
    expect(back.body.status).toBe(0);
    expect(back.body.messages[2].author.displayName).toBe('مستخدم الدعم');
    const closed = await request(http).post(`/api/v1/support/tickets/${t.body.id}/close`).set(auth(merchant.token)).expect(201);
    expect(closed.body.status).toBe(2);
    const alerts = await prisma.platformAlert.findMany({ where: { kind: 'support', data: { path: ['ticketId'], equals: t.body.id } } });
    expect(alerts.length).toBe(2);
  });
});
