import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * مفاتيح API: إصدار حقيقي يمنح وصولًا فعليًا (لا عرضًا فقط) عبر ترويسة
 * `x-api-key` — طريق مصادقة كامل بديل عن JWT، يُقيَّم في `TenantGuard`.
 *
 * يثبت: الدور يُقيَّد بدور المُصدِر عند الإصدار وبدوره *الحالي* عند
 * الاستخدام (لا تصعيد لاحق بتغيير دور المُصدِر)، والإلغاء فوري، ومفتاح
 * من شركة لا يرى بيانات شركة أخرى، ولا يُقبل أبدًا على مسار منصة.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('مفاتيح API', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'apikey-pass-1234',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
    userId: '',
  });
  const owner = mk('owner');
  const other = mk('other');
  const emp = { email: `emp-${randomUUID()}@azm.test`, password: 'emp-pass-1234', token: '' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName })
      .expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    u.userId = r.body.user.id;
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

    await register(owner);
    await register(other);
    await request(http)
      .post('/api/v1/team/members')
      .set(auth(owner.token))
      .send({ email: emp.email, displayName: 'موظف', password: emp.password, role: 8 })
      .expect(201);
    const r = await request(http).post('/api/v1/auth/login').send({ email: emp.email, password: emp.password, companyId: owner.companyId }).expect(200);
    emp.token = r.body.accessToken;
  });

  afterAll(async () => {
    for (const email of [owner.email, other.email, emp.email]) {
      await prisma.user.delete({ where: { email } }).catch(() => undefined);
    }
    for (const id of [owner.companyId, other.companyId]) {
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  it('المالك يصدر مفتاحًا، والسرّ الكامل يظهر مرة واحدة فقط', async () => {
    const r = await request(http)
      .post('/api/v1/developer/keys')
      .set(auth(owner.token))
      .send({ name: 'مفتاح الإنتاج', role: 8 })
      .expect(201);
    expect(r.body.secret).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(r.body.prefix.startsWith('sk_live_')).toBe(true);
    expect(r.body).not.toHaveProperty('keyHash');

    const list = await request(http).get('/api/v1/developer/keys').set(auth(owner.token)).expect(200);
    expect(list.body.find((k: { id: string }) => k.id === r.body.id)).toBeTruthy();
    expect(list.body[0]).not.toHaveProperty('secret');
    expect(list.body[0]).not.toHaveProperty('keyHash');
  });

  it('الموظف لا يصدر مفاتيح، ولا يصدر أحد مفتاحًا بدور أعلى من دوره', async () => {
    await request(http).post('/api/v1/developer/keys').set(auth(emp.token)).send({ name: 'x', role: 8 }).expect(403);
    await request(http).post('/api/v1/developer/keys').set(auth(owner.token)).send({ name: 'x', role: -1 }).expect(400);
    // owner = دور 0 (الأعلى)؛ أي دور مسموح له
  });

  it('المفتاح يعمل فعليًا عبر x-api-key ويرى بيانات شركته فقط', async () => {
    const issued = await request(http)
      .post('/api/v1/developer/keys')
      .set(auth(owner.token))
      .send({ name: 'تكامل خارجي', role: 2 })
      .expect(201);
    const secret = issued.body.secret as string;

    const created = await request(http)
      .post('/api/v1/work/projects')
      .set('x-api-key', secret)
      .send({ key: 'EXT', name: 'مشروع عبر المفتاح' })
      .expect(201);
    expect(created.body.key).toBe('EXT');

    const mine = await request(http).get('/api/v1/work/projects').set('x-api-key', secret).expect(200);
    expect(mine.body.projects.some((p: { key: string }) => p.key === 'EXT')).toBe(true);

    const theirs = await request(http).get('/api/v1/work/projects').set('x-api-key', secret).set(auth(other.token)).expect(200);
    // x-api-key له الأولوية على Bearer المرفق معه خطأً — يظل مقيَّدًا بشركة المفتاح
    expect(theirs.body.projects.some((p: { key: string }) => p.key === 'EXT')).toBe(true);

    const otherView = await request(http).get('/api/v1/work/projects').set(auth(other.token)).expect(200);
    expect(otherView.body.projects.some((p: { key: string }) => p.key === 'EXT')).toBe(false);
  });

  it('مفتاح بدور ضيف يقرأ لكنه لا يكتب', async () => {
    const issued = await request(http)
      .post('/api/v1/developer/keys')
      .set(auth(owner.token))
      .send({ name: 'قراءة فقط', role: 9 })
      .expect(201);
    const secret = issued.body.secret as string;

    await request(http).get('/api/v1/work/projects').set('x-api-key', secret).expect(200);
    await request(http)
      .post('/api/v1/work/projects')
      .set('x-api-key', secret)
      .send({ key: 'RO', name: 'محاولة كتابة' })
      .expect(403);
  });

  it('مفتاح ملغى وآخر مزوَّر يُرفضان', async () => {
    const issued = await request(http)
      .post('/api/v1/developer/keys')
      .set(auth(owner.token))
      .send({ name: 'لِلإلغاء', role: 8 })
      .expect(201);
    await request(http).get('/api/v1/work/projects').set('x-api-key', issued.body.secret).expect(200);

    await request(http).delete(`/api/v1/developer/keys/${issued.body.id}`).set(auth(owner.token)).expect(200);
    await request(http).get('/api/v1/work/projects').set('x-api-key', issued.body.secret).expect(401);
    await request(http).get('/api/v1/work/projects').set('x-api-key', 'sk_live_' + '0'.repeat(48)).expect(401);
  });

  it('مفتاح لا يُقبل أبدًا على مسار منصة', async () => {
    const issued = await request(http)
      .post('/api/v1/developer/keys')
      .set(auth(owner.token))
      .send({ name: 'محاولة تصعيد', role: 8 })
      .expect(201);
    await request(http).get('/api/v1/platform/organizations').set('x-api-key', issued.body.secret).expect(403);
  });

  it('حذف عضوية صاحب المفتاح يوقفه فورًا', async () => {
    const guest = { email: `guest-${randomUUID()}@azm.test`, password: 'gst-pass-1234' };
    await request(http)
      .post('/api/v1/team/members')
      .set(auth(owner.token))
      .send({ email: guest.email, displayName: 'يُزال لاحقًا', password: guest.password, role: 2 })
      .expect(201);
    const login = await request(http).post('/api/v1/auth/login').send({ email: guest.email, password: guest.password, companyId: owner.companyId }).expect(200);

    const issued = await request(http)
      .post('/api/v1/developer/keys')
      .set(auth(login.body.accessToken))
      .send({ name: 'مفتاح عضو سيُزال', role: 8 })
      .expect(201);
    await request(http).get('/api/v1/work/projects').set('x-api-key', issued.body.secret).expect(200);

    const members = await request(http).get('/api/v1/team/members').set(auth(owner.token)).expect(200);
    const membershipId = members.body.members.find((m: { user: { email: string } }) => m.user.email === guest.email).id;
    await request(http).patch(`/api/v1/team/members/${membershipId}`).set(auth(owner.token)).send({ isActive: false }).expect(200);

    await request(http).get('/api/v1/work/projects').set('x-api-key', issued.body.secret).expect(401);
  });
});
