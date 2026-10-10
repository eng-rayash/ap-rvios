import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * وحدة العمل: مشاريع ومهام وإشعارات ونشاط وفريق
 *
 * يثبت: عزم الشركات (لا مشروع ولا مهمة ولا إشعار يعبر شركة)، وحدود الأدوار،
 * وأن الإسناد لا يقبل غير أعضاء الشركة، وترقيم المهام متسلسل حتى مع
 * التزامن، وأن الإشعار يصل للمُسنَد إليه فقط، وحذف المشروع يحذف مهامه.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('وحدة العمل', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'work-pass-1234',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
    userId: '',
  });
  const owner = mk('owner');
  const other = mk('other');
  const emp = { email: `emp-${randomUUID()}@azm.test`, password: 'emp-pass-1234', token: '', userId: '' };
  const guest = { email: `guest-${randomUUID()}@azm.test`, password: 'gst-pass-1234', token: '', userId: '' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let projectId = '';
  let taskId = '';

  const post = (p: string, t: string, body: object = {}) => request(http).post(`/api/v1${p}`).set(auth(t)).send(body);
  const patch = (p: string, t: string, body: object = {}) => request(http).patch(`/api/v1${p}`).set(auth(t)).send(body);
  const get = (p: string, t: string) => request(http).get(`/api/v1${p}`).set(auth(t));
  const del = (p: string, t: string) => request(http).delete(`/api/v1${p}`).set(auth(t));

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName })
      .expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    u.userId = r.body.user.id;
  }

  async function login(u: { email: string; password: string; token: string; userId: string }, companyId: string) {
    const r = await request(http).post('/api/v1/auth/login').send({ email: u.email, password: u.password, companyId }).expect(200);
    u.token = r.body.accessToken;
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

    await post('/team/members', owner.token, { email: emp.email, displayName: 'موظف', password: emp.password, role: 8 }).expect(201);
    await post('/team/members', owner.token, { email: guest.email, displayName: 'ضيف', password: guest.password, role: 9 }).expect(201);
    await login(emp, owner.companyId);
    await login(guest, owner.companyId);
  });

  afterAll(async () => {
    for (const email of [owner.email, other.email, emp.email, guest.email]) {
      await prisma.user.delete({ where: { email } }).catch(() => undefined);
    }
    for (const id of [owner.companyId, other.companyId]) {
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  describe('السياق والفريق', () => {
    it('سياق الجلسة يصف المستخدم والدور ولا يدّعي منصة', async () => {
      const r = await get('/auth/context', owner.token).expect(200);
      expect(r.body.role).toBe(0);
      expect(r.body.platformRole).toBeNull();
      expect(r.body.isSite).toBe(false);
      expect(r.body.user.email).toBe(owner.email);
    });

    it('الموظف لا يضيف أعضاء ولا يمنح دورًا أعلى منه', async () => {
      await post('/team/members', emp.token, { email: 'x@azm.test', displayName: 'س س', password: 'abcdefgh', role: 8 }).expect(403);
    });

    it('الملف الشخصي يُعدَّل، وغير http يُرفض كصورة، والبريد لا يُعدَّل', async () => {
      const r = await patch('/me/profile', emp.token, { displayName: 'موظف معدَّل', phone: '777' }).expect(200);
      expect(r.body.displayName).toBe('موظف معدَّل');
      expect(r.body.email).toBe(emp.email);
      await patch('/me/profile', emp.token, { avatarUrl: 'javascript:alert(1)' }).expect(400);
      await patch('/me/profile', emp.token, { email: 'x@evil.test' }).expect(400);
    });

    it('تغيير كلمة المرور يتطلب الحالية الصحيحة ثم يعمل الدخول بالجديدة', async () => {
      // ٤٠٠ لا ٤٠١: الجلسة سليمة، والخطأ في المُدخل — والواجهة تُخرج المستخدم عند ٤٠١
      await post('/me/password', emp.token, { currentPassword: 'wrong-password', newPassword: 'brand-new-pass-1' }).expect(400);
      await post('/me/password', emp.token, { currentPassword: emp.password, newPassword: 'short' }).expect(400);
      // `iat` بالثواني: ثانية فاصلة تجعل الرمز القديم أسبق من التغيير يقينًا
      await new Promise((r) => setTimeout(r, 1100));
      const old = emp.token;
      const r = await post('/me/password', emp.token, { currentPassword: emp.password, newPassword: 'brand-new-pass-1' }).expect(201);
      expect(r.body.accessToken).toEqual(expect.any(String));
      emp.token = r.body.accessToken;
      // الرمز السابق (المسروق مثلًا) سقط، والجديد يعمل
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${old}`).expect(401);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${emp.token}`).expect(200);
      await request(http).post('/api/v1/auth/login').send({ email: emp.email, password: emp.password }).expect(401);
      await request(http).post('/api/v1/auth/login').send({ email: emp.email, password: 'brand-new-pass-1' }).expect(200);
    });

    it('التبديل إلى شركة لا ينتمي إليها مرفوض', async () => {
      await post('/auth/switch', emp.token, { companyId: other.companyId }).expect(401);
    });
  });

  describe('المشاريع', () => {
    it('المالك ينشئ مشروعًا: الرمز يُكبَّر، والقائد أنا، والتقدّم صفر', async () => {
      const r = await post('/work/projects', owner.token, { key: 'app', name: 'تطبيق الجوال', memberIds: [emp.userId] }).expect(201);
      projectId = r.body.id;
      expect(r.body.key).toBe('APP');
      expect(r.body.lead.id).toBe(owner.userId);
      expect(r.body.members.map((m: { id: string }) => m.id).sort()).toEqual([owner.userId, emp.userId].sort());
      expect(r.body.progress).toBe(0);
    });

    it('الرمز المكرر يُرفض، والموظف لا ينشئ مشروعًا', async () => {
      await post('/work/projects', owner.token, { key: 'APP', name: 'آخر' }).expect(409);
      await post('/work/projects', emp.token, { key: 'ZZZ', name: 'ممنوع' }).expect(403);
    });

    it('لا يُقبل عضو من شركة أخرى', async () => {
      await post('/work/projects', owner.token, { key: 'BAD', name: 'مشروع', memberIds: [other.userId] }).expect(400);
    });

    it('الشركة الأخرى لا ترى المشروع ولا تعدّله', async () => {
      await get(`/work/projects/${projectId}`, other.token).expect(404);
      await patch(`/work/projects/${projectId}`, other.token, { name: 'اختراق' }).expect(404);
      const list = await get('/work/projects', other.token).expect(200);
      expect(list.body.projects).toHaveLength(0);
    });
  });

  describe('المهام', () => {
    it('المهام تُرقَّم تسلسليًا وتحمل رمز المشروع', async () => {
      const r = await post('/work/tasks', owner.token, { projectId, title: 'تصميم الشاشة', assigneeId: emp.userId, priority: 2 }).expect(201);
      taskId = r.body.id;
      expect(r.body.code).toBe('APP-1');
      expect(r.body.assignee.id).toBe(emp.userId);
    });

    it('الإسناد لغير عضو مرفوض', async () => {
      await post('/work/tasks', owner.token, { projectId, title: 'مهمة', assigneeId: other.userId }).expect(400);
    });

    it('عدة مهام متزامنة تأخذ أرقامًا مختلفة', async () => {
      const rs = await Promise.all(
        Array.from({ length: 5 }, (_, i) => post('/work/tasks', owner.token, { projectId, title: `مهمة ${i}` })),
      );
      rs.forEach((r) => expect(r.status).toBe(201));
      const numbers = rs.map((r) => r.body.number);
      expect(new Set(numbers).size).toBe(5);
    });

    it('المُسنَد إليه يصله إشعار، والمالك (الفاعل) لا يصله شيء', async () => {
      const mine = await get('/notifications', emp.token).expect(200);
      expect(mine.body.unread).toBeGreaterThan(0);
      expect(mine.body.notifications[0].link).toBe(`/projects/${projectId}`);
      const ownerN = await get('/notifications', owner.token).expect(200);
      expect(ownerN.body.notifications.filter((n: { kind: string }) => n.kind === 'assign')).toHaveLength(0);
    });

    it('الموظف يحرّك مهمته، والضيف للقراءة فقط', async () => {
      const r = await patch(`/work/tasks/${taskId}`, emp.token, { status: 4 }).expect(200);
      expect(r.body.completedAt).not.toBeNull();
      await patch(`/work/tasks/${taskId}`, guest.token, { status: 1 }).expect(403);
      await get('/work/tasks', guest.token).expect(200);
    });

    it('التقدّم يُحسب من المهام المكتملة', async () => {
      const p = await get(`/work/projects/${projectId}`, owner.token).expect(200);
      expect(p.body.taskCounts).toEqual({ total: 6, done: 1 });
      expect(p.body.progress).toBe(17);
    });

    it('«مهامي» تُرجع مهام المستخدم فقط', async () => {
      const r = await get('/work/tasks?assignee=me', emp.token).expect(200);
      expect(r.body.tasks).toHaveLength(1);
      expect(r.body.tasks[0].id).toBe(taskId);
    });

    it('الشركة الأخرى لا ترى المهام ولا تنشئ داخل مشروعنا', async () => {
      await get(`/work/tasks/${taskId}`, other.token).expect(404);
      await post('/work/tasks', other.token, { projectId, title: 'دخيل' }).expect(404);
      const r = await get(`/work/tasks?projectId=${projectId}`, other.token).expect(200);
      expect(r.body.tasks).toHaveLength(0);
    });

    it('التعليق يُشعر صاحب المهمة ويظهر باسم كاتبه', async () => {
      const c = await post(`/work/tasks/${taskId}/comments`, owner.token, { body: 'أحسنت' }).expect(201);
      expect(c.body.author.id).toBe(owner.userId);
      const list = await get(`/work/tasks/${taskId}/comments`, emp.token).expect(200);
      expect(list.body.comments).toHaveLength(1);
      const n = await get('/notifications?unread=1', emp.token).expect(200);
      expect(n.body.notifications.some((x: { kind: string }) => x.kind === 'comment')).toBe(true);
    });
  });

  describe('الإشعارات', () => {
    it('لا يقرأ أحد إشعار غيره ولا يحذفه', async () => {
      const mine = await get('/notifications', emp.token).expect(200);
      const id = mine.body.notifications[0].id;
      await patch(`/notifications/${id}/read`, owner.token).expect(404);
      await del(`/notifications/${id}`, other.token).expect(404);
      await patch(`/notifications/${id}/read`, emp.token).expect(200);
    });

    it('«قراءة الكل» تصفّر العدّاد', async () => {
      await post('/notifications/read-all', emp.token).expect(201);
      const c = await get('/notifications/count', emp.token).expect(200);
      expect(c.body.unread).toBe(0);
    });
  });

  describe('النشاط', () => {
    it('يُسجَّل نشاط الشركة ولا تراه الشركة الأخرى', async () => {
      const r = await get('/activity', owner.token).expect(200);
      expect(r.body.activity.some((a: { action: string }) => a.action === 'task.created')).toBe(true);
      expect(r.body.activity[0].actor).toBeTruthy();
      const o = await get('/activity', other.token).expect(200);
      expect(o.body.activity).toHaveLength(0);
    });

    it('نشاط المشروع يُفلتر بمعرّفه ولا يخلط مشروعًا بآخر', async () => {
      const p2 = await post('/work/projects', owner.token, { key: 'SEC', name: 'مشروع ثانٍ' }).expect(201);
      await post('/work/tasks', owner.token, { projectId: p2.body.id, title: 'مهمة معزولة' }).expect(201);
      const mine = await get(`/activity?projectId=${projectId}`, owner.token).expect(200);
      const theirs = await get(`/activity?projectId=${p2.body.id}`, owner.token).expect(200);
      expect(mine.body.activity.length).toBeGreaterThan(theirs.body.activity.length);
      expect(theirs.body.activity.every((a: { description: string }) => !a.description.includes('APP-'))).toBe(true);
      expect(theirs.body.activity.some((a: { description: string }) => a.description.includes('SEC-1'))).toBe(true);
      await del(`/work/projects/${p2.body.id}`, owner.token).expect(200);
    });
  });

  describe('المعالم والحذف', () => {
    it('معلم يُضاف ويُنجَز', async () => {
      const m = await post(`/work/projects/${projectId}/milestones`, owner.token, { title: 'الإصدار التجريبي', date: '2026-12-01' }).expect(201);
      const u = await patch(`/work/milestones/${m.body.id}`, owner.token, { done: true }).expect(200);
      expect(u.body.done).toBe(true);
      await patch(`/work/milestones/${m.body.id}`, other.token, { done: false }).expect(404);
    });

    it('حذف المشروع يحذف مهامه، ولا يحذفه الموظف', async () => {
      await del(`/work/projects/${projectId}`, emp.token).expect(403);
      await del(`/work/projects/${projectId}`, owner.token).expect(200);
      await get(`/work/tasks/${taskId}`, owner.token).expect(404);
    });
  });
});
