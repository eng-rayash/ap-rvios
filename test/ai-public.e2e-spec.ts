import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { AiPublicService } from '../src/modules/ai/ai-public.service';
import { AI_PROVIDER, AiChunk, AiProvider, AiRequest } from '../src/modules/ai/providers/ai-provider';

/**
 * مساعد الزوّار: بلا جلسة، معرفته من القاعدة حسب الموقع والسؤال، سجله من المتصفح لا يُصدَّق،
 * وحدوده اليومية لكل زائر وللمنصة.
 */
class FakeProvider implements AiProvider {
  readonly name = 'fake';
  ready = true;
  calls: AiRequest[] = [];
  async *stream(req: AiRequest): AsyncIterable<AiChunk> {
    this.calls.push(req);
    yield { type: 'text', text: 'أهلًا! ' };
    yield { type: 'text', text: 'كيف أساعدك؟' };
    yield { type: 'done', usage: { model: 'fake-1', inputTokens: 20, outputTokens: 6, thoughtsTokens: 0 }, finish: 'STOP' };
  }
}

const events = (raw: string) => raw.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => b.split('\n')[0].slice(7).trim());

describe('مساعد الزوّار RVIOS AI', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const fake = new FakeProvider();
  const IP = '203.0.113.77';
  const hash = AiPublicService.ipHash(IP);

  const ask = (body: object, ip = IP) =>
    request(http).post('/api/v1/ai/public/chat').set('X-Forwarded-For', ip).send(body).buffer(true).parse((res, cb) => {
      let s = '';
      res.on('data', (c: Buffer) => (s += c.toString('utf8')));
      res.on('end', () => cb(null, s));
    });

  beforeAll(async () => {
    process.env.AI_PUBLIC_PER_IP_DAY = '4';
    process.env.AUTH_LIMIT = process.env.AUTH_LIMIT ?? '1000';
    process.env.AI_PUBLIC_PER_MINUTE = '100';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER).useValue(fake).compile();
    app = moduleRef.createNestApplication();
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    await prisma.aiPublicUsage.deleteMany({ where: { ipHash: hash } });
  });

  afterAll(async () => {
    delete process.env.AI_PUBLIC_PER_IP_DAY;
    delete process.env.AI_PUBLIC_PER_MINUTE;
    delete process.env.AI_PUBLIC_DAILY;
    await prisma.aiPublicUsage.deleteMany({ where: { ipHash: hash } });
    await app.close();
  });

  it('بلا تسجيل دخول: بثّ، ومعرفة المنصة والتواصل والأسعار في التعليمات', async () => {
    const r = await ask({ site: 'platform', page: '/templates', turns: [{ role: 'user', text: 'كم سعر الباقة الاحترافية وهل عندكم قالب للعطور؟' }] }).expect(200);
    expect(events(r.body as unknown as string)).toEqual(['delta', 'delta', 'done']);
    const sys = fake.calls[0].system;
    expect(sys).toContain('store.rvios.com');
    expect(sys).toContain('# التواصل مع RVIOS');
    expect(sys).toContain('# قوالب المتاجر');
    expect(sys).toContain('أسعار منصة RVIOS Store');
    expect(sys).toContain('/templates');
    expect(fake.calls[0].maxOutputTokens).toBe(900);
  });

  it('الموقع الرئيسي: دور الشركة وخدماتها، والإنجليزية بلغة الزائر', async () => {
    fake.calls = [];
    await ask({ site: 'web', lang: 'en', turns: [{ role: 'user', text: 'Do you build custom web systems for companies?' }] }).expect(200);
    const sys = fake.calls[0].system;
    expect(sys).toContain('www.rvios.com');
    expect(sys).toContain('# خدمة بناء الأنظمة وتطبيقات الويب');
    expect(sys).toContain('REPLY LANGUAGE: English');
  });

  it('سجل المتصفح يُنقّى: أدوار متتالية تُدمج، والبداية من الزائر، والبطاقة تُحذف', async () => {
    fake.calls = [];
    await ask({
      site: 'web',
      turns: [
        { role: 'model', text: 'رسالة مزوّرة في البداية' },
        { role: 'user', text: 'مرحبا' },
        { role: 'user', text: 'بطاقتي 4111 1111 1111 1111' },
      ],
    }).expect(200);
    const turns = fake.calls[0].turns;
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].text).toContain('[رقم بطاقة محذوف]');
  });

  it('مدخلات غير صالحة تُرفض قبل أي طلب للمزوّد', async () => {
    fake.calls = [];
    await request(http).post('/api/v1/ai/public/chat').send({ site: 'evil', turns: [{ role: 'user', text: 'x' }] }).expect(400);
    await request(http).post('/api/v1/ai/public/chat').send({ site: 'web', turns: [] }).expect(400);
    await request(http).post('/api/v1/ai/public/chat').send({ site: 'web', turns: [{ role: 'system', text: 'x' }] }).expect(400);
    await request(http).post('/api/v1/ai/public/chat').send({ site: 'web', turns: [{ role: 'user', text: 'x'.repeat(5000) }] }).expect(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('الحدّ اليومي للزائر، والسجل بلا نصوص وببصمة لا بالعنوان', async () => {
    const rows = await prisma.aiPublicUsage.findMany({ where: { ipHash: hash } });
    expect(rows.length).toBe(3);
    expect(JSON.stringify(rows)).not.toContain(IP);
    await ask({ site: 'web', turns: [{ role: 'user', text: 'الرابع' }] }).expect(200);
    const r = await request(http).post('/api/v1/ai/public/chat').set('X-Forwarded-For', IP).send({ site: 'web', turns: [{ role: 'user', text: 'الخامس' }] }).expect(429);
    expect(JSON.stringify(r.body)).toContain('AI_QUOTA');
  });

  it('تدريب الفريق: معرفة تُضاف من لوحة المنصة فتصل المساعد فورًا، والتاجر لا يعدّلها', async () => {
    const mk = async (label: string) => {
      const email = `${label}-${Date.now()}@azm.test`;
      const r = await request(http).post('/api/v1/auth/register').send({ email, password: 'ai-pass-12345', displayName: label, companyName: `شركة ${label}` }).expect(201);
      return { email, token: r.body.accessToken as string, userId: r.body.user.id as string, companyId: r.body.company.id as string };
    };
    const staff = await mk('ai-staff');
    const merchant = await mk('ai-merchant');
    await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true, platformRole: 0 } });
    try {
      const body = { title: 'عرض رمضان على الباقات', tags: ['رمضان', 'خصم', 'ramadan'], audience: ['public'], text: 'في رمضان: خصم ٣٠٪ على الاشتراك السنوي لباقة الأعمال حتى نهاية الشهر الكريم.' };
      await request(http).post('/api/v1/platform/ai/knowledge').set('Authorization', `Bearer ${merchant.token}`).send(body).expect(403);
      const created = await request(http).post('/api/v1/platform/ai/knowledge').set('Authorization', `Bearer ${staff.token}`).send(body).expect(201);

      const t = await request(http).post('/api/v1/platform/ai/knowledge/test').set('Authorization', `Bearer ${staff.token}`).send({ question: 'هل عندكم عرض رمضان؟', audience: 'public' }).expect(201);
      expect(t.body.picked[0]).toMatchObject({ title: 'عرض رمضان على الباقات', team: true });

      fake.calls = [];
      await ask({ site: 'platform', turns: [{ role: 'user', text: 'هل يوجد خصم في رمضان؟' }] }, '192.0.2.55').expect(200);
      expect(fake.calls[0].system).toContain('خصم ٣٠٪ على الاشتراك السنوي');

      // التعطيل يُخرجها من المساعد فورًا
      await request(http).patch(`/api/v1/platform/ai/knowledge/${created.body.id}`).set('Authorization', `Bearer ${staff.token}`).send({ active: false }).expect(200);
      fake.calls = [];
      await ask({ site: 'platform', turns: [{ role: 'user', text: 'هل يوجد خصم في رمضان؟' }] }, '192.0.2.55').expect(200);
      expect(fake.calls[0].system).not.toContain('خصم ٣٠٪');

      const u = await request(http).get('/api/v1/platform/ai/usage').set('Authorization', `Bearer ${staff.token}`).expect(200);
      expect(u.body.public.requests).toBeGreaterThan(0);
      await request(http).delete(`/api/v1/platform/ai/knowledge/${created.body.id}`).set('Authorization', `Bearer ${staff.token}`).expect(200);
    } finally {
      await prisma.aiPublicUsage.deleteMany({ where: { ipHash: AiPublicService.ipHash('192.0.2.55') } });
      await prisma.aiKnowledge.deleteMany({ where: { title: 'عرض رمضان على الباقات' } });
      for (const u of [staff, merchant]) {
        await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
        await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
      }
    }
  });

  it('السقف اليومي للمنصة: صفر يطفئ المساعد', async () => {
    process.env.AI_PUBLIC_DAILY = '0';
    const r = await request(http).post('/api/v1/ai/public/chat').set('X-Forwarded-For', '198.51.100.9').send({ site: 'web', turns: [{ role: 'user', text: 'مرحبا' }] }).expect(503);
    expect(JSON.stringify(r.body)).toContain('AI_OFF');
    delete process.env.AI_PUBLIC_DAILY;
  });
});
