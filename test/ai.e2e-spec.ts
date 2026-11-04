import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { AI_PROVIDER, AiChunk, AiProvider, AiProviderError, AiRequest } from '../src/modules/ai/providers/ai-provider';

/**
 * RVIOS AI — المحادثة بثًّا وحفظها، وعزل المحادثات بين المتاجر، والحصّة، والتنقية،
 * وأدوات الكتابة. المزوّد مُستبدَل بمزوّد وهمي يسجّل ما يصله: الاختبار لا يكلّف
 * شيئًا، ويثبت ما يُرسل إلى المزوّد فعلًا (بيانات المتجر، التنقية).
 */
class FakeProvider implements AiProvider {
  readonly name = 'fake';
  ready = true;
  calls: AiRequest[] = [];
  /** فشل قادم: قبل التوليد، أو بعد جزء من الرد */
  failNext: null | 'before' | 'after' = null;

  async *stream(req: AiRequest): AsyncIterable<AiChunk> {
    this.calls.push(req);
    const fail = this.failNext;
    this.failNext = null;
    if (fail === 'before') throw new AiProviderError('unavailable', 'busy');
    if (req.jsonSchema) {
      const props = Object.keys((req.jsonSchema as { properties: object }).properties);
      const obj = Object.fromEntries(props.map((k) => [k, k === 'items' ? [{ text: 'منشور', hashtags: ['#عطور'] }] : /s$/.test(k) ? ['أ', 'ب'] : `قيمة ${k}`]));
      yield { type: 'text', text: JSON.stringify(obj) };
    } else if (req.tier === 'lite') {
      yield { type: 'text', text: 'عنوان تجريبي' };
    } else {
      const last = req.turns[req.turns.length - 1]?.text ?? '';
      yield { type: 'text', text: 'رد: ' };
      if (fail === 'after') throw new AiProviderError('network', 'cut', true);
      yield { type: 'text', text: last.slice(0, 40) };
    }
    yield { type: 'done', usage: { model: 'fake-1', inputTokens: 10, outputTokens: 5, thoughtsTokens: 0 }, finish: 'STOP' };
  }
}

type Ev = { event: string; data: Record<string, unknown> };
const parseSse = (raw: string): Ev[] =>
  raw.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => {
    const [e, d] = b.split('\n');
    return { event: e.slice(7).trim(), data: JSON.parse(d.slice(5)) };
  });

describe('RVIOS AI', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const fake = new FakeProvider();

  const RUN = randomUUID().slice(0, 8);
  const mk = (label: string) => ({ email: `${label}-${randomUUID()}@azm.test`, password: 'ai-pass-12345', displayName: label, companyName: `شركة ${label}`, token: '', companyId: '', userId: '' });
  const a = mk('ai-a');
  const b = mk('ai-b');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let storeA = '';
  let storeB = '';
  let conv = '';

  const chat = (token: string, store: string, body: object) =>
    request(http).post(`/api/v1/shop/stores/${store}/ai/chat`).set(auth(token)).send(body).buffer(true).parse((res, cb) => {
      let s = '';
      res.on('data', (c: Buffer) => (s += c.toString('utf8')));
      res.on('end', () => cb(null, s));
    });

  beforeAll(async () => {
    process.env.AI_LIMIT_BASIC = '6';
    process.env.AI_PER_MINUTE = '100';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER).useValue(fake).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    for (const u of [a, b]) {
      const r = await request(http).post('/api/v1/auth/register').send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName }).expect(201);
      Object.assign(u, { token: r.body.accessToken, companyId: r.body.company.id, userId: r.body.user.id });
    }
    const sa = await request(http).post('/api/v1/shop/stores').set(auth(a.token)).send({ name: 'عطور ألفا', slug: `ai-a-${RUN}`, country: 'YE', whatsapp: '777123456' }).expect(201);
    storeA = sa.body.store.id;
    const sb = await request(http).post('/api/v1/shop/stores').set(auth(b.token)).send({ name: 'متجر بيتا', slug: `ai-b-${RUN}`, country: 'SA', whatsapp: '512345678' }).expect(201);
    storeB = sb.body.store.id;
    await request(http).post(`/api/v1/shop/stores/${storeA}/products`).set(auth(a.token)).send({ name: 'دهن عود كمبودي', price: 45000, qty: 3 }).expect(201);
  });

  afterAll(async () => {
    delete process.env.AI_LIMIT_BASIC;
    delete process.env.AI_PER_MINUTE;
    for (const u of [a, b]) {
      if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('الحالة: جاهز، والحصّة حسب باقة المتجر', async () => {
    const r = await request(http).get(`/api/v1/shop/stores/${storeA}/ai/status`).set(auth(a.token)).expect(200);
    expect(r.body).toMatchObject({ ready: true, plan: 'basic', used: 0, limit: 6 });
  });

  it('محادثة جديدة: بثّ، وحفظ، وعنوان تلقائي، وبيانات المتجر في التعليمات', async () => {
    const r = await chat(a.token, storeA, { message: 'كيف أزيد مبيعات العطور؟' }).expect(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const ev = parseSse(r.body as unknown as string);
    expect(ev.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'title', 'done']);
    conv = ev[0].data.conversationId as string;
    expect(ev.find((e) => e.event === 'title')?.data.title).toBe('عنوان تجريبي');
    expect(ev.at(-1)?.data).toMatchObject({ status: 'ok', used: 1, limit: 6 });

    const main = fake.calls.find((c) => !c.tier && !c.jsonSchema)!;
    expect(main.system).toContain('<store_data>');
    expect(main.system).toContain('دهن عود كمبودي');
    expect(main.system).not.toContain('# الأداء'); // وضع المحادثة العامة بلا تحليلات

    const g = await request(http).get(`/api/v1/shop/stores/${storeA}/ai/conversations/${conv}`).set(auth(a.token)).expect(200);
    expect(g.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'model']);
    expect(g.body.messages[1].content).toContain('كيف أزيد');
    expect(g.body.title).toBe('عنوان تجريبي');
  });

  it('المتابعة ترسل السياق السابق، والتنقية تحذف رقم البطاقة والمفتاح قبل الحفظ والإرسال', async () => {
    fake.calls = [];
    await chat(a.token, storeA, { conversationId: conv, message: 'بطاقتي 4111 1111 1111 1111 ومفتاحي AIzaSyA1234567890abcdefghijkLMNOP' }).expect(200);
    const sent = fake.calls[0];
    expect(sent.turns.map((t) => t.role)).toEqual(['user', 'model', 'user']);
    const last = sent.turns[2].text;
    expect(last).toContain('[رقم بطاقة محذوف]');
    expect(last).toContain('[مفتاح محذوف]');
    expect(last).not.toContain('4111');
    const rows = await prisma.aiMessage.findMany({ where: { conversationId: conv, role: 'user' } });
    expect(rows.some((m) => m.content.includes('4111'))).toBe(false);
  });

  it('إعادة التوليد تستبدل آخر رد ولا تكرر رسالة التاجر', async () => {
    const before = await prisma.aiMessage.count({ where: { conversationId: conv } });
    const r = await chat(a.token, storeA, { conversationId: conv, regenerate: true }).expect(200);
    expect(parseSse(r.body as unknown as string).at(-1)?.event).toBe('done');
    expect(await prisma.aiMessage.count({ where: { conversationId: conv } })).toBe(before);
  });

  it('وضع التحليلات يرسل أرقام المتجر الفعلية', async () => {
    fake.calls = [];
    const r = await chat(a.token, storeA, { message: 'حلّل أداء متجري', mode: 'insights' }).expect(200);
    expect(parseSse(r.body as unknown as string)[0].data.mode).toBe('insights');
    expect(fake.calls[0].system).toContain('# الأداء: آخر ٣٠ يومًا');
    expect(fake.calls[0].system).toContain('الطلبات: 0');
  });

  it('العزل: متجر آخر ومستخدم آخر لا يريان المحادثة ولا يكتبان فيها', async () => {
    await request(http).get(`/api/v1/shop/stores/${storeA}/ai/conversations`).set(auth(b.token)).expect(404);
    await request(http).get(`/api/v1/shop/stores/${storeB}/ai/conversations/${conv}`).set(auth(b.token)).expect(404);
    await chat(b.token, storeB, { conversationId: conv, message: 'أهلًا' }).expect(404);
    const list = await request(http).get(`/api/v1/shop/stores/${storeB}/ai/conversations`).set(auth(b.token)).expect(200);
    expect(list.body).toEqual([]);
  });

  it('خطأ المزوّد قبل التوليد لا يُحتسب، وانقطاعه بعد بدئه يحفظ ما وصل', async () => {
    const used = (await request(http).get(`/api/v1/shop/stores/${storeA}/ai/status`).set(auth(a.token))).body.used;
    fake.failNext = 'before';
    const e1 = parseSse((await chat(a.token, storeA, { conversationId: conv, message: 'سؤال' }).expect(200)).body as unknown as string);
    expect(e1.at(-1)).toMatchObject({ event: 'error', data: { code: 'unavailable', messageId: null } });
    expect((await request(http).get(`/api/v1/shop/stores/${storeA}/ai/status`).set(auth(a.token))).body.used).toBe(used);

    fake.failNext = 'after';
    const e2 = parseSse((await chat(a.token, storeA, { conversationId: conv, message: 'سؤال آخر' }).expect(200)).body as unknown as string);
    expect(e2.at(-1)?.event).toBe('error');
    const partial = await prisma.aiMessage.findUnique({ where: { id: e2.at(-1)!.data.messageId as string } });
    expect(partial).toMatchObject({ role: 'model', status: 'error', content: 'رد: ' });
  });

  it('أدوات الكتابة: نتيجة منظّمة بالمخطط، والإدخال الناقص يُرفض', async () => {
    const r = await request(http).post(`/api/v1/shop/stores/${storeA}/ai/generate`).set(auth(a.token))
      .send({ tool: 'product', language: 'ar', product: { name: 'عطر عود', details: '٥٠ مل' } }).expect(200);
    expect(r.body.result).toMatchObject({ title: 'قيمة title', keywords: ['أ', 'ب'] });
    expect(fake.calls.at(-1)?.jsonSchema).toBeTruthy();
    await request(http).post(`/api/v1/shop/stores/${storeA}/ai/generate`).set(auth(a.token)).send({ tool: 'seo', language: 'ar' }).expect(400);
    await request(http).post(`/api/v1/shop/stores/${storeA}/ai/generate`).set(auth(a.token))
      .send({ tool: 'marketing', language: 'ar', marketing: { topic: 'عرض', platform: 'myspace' } }).expect(400);
  });

  it('الحصّة الشهرية: الطلب بعد آخرها يُرفض برمزه قبل البث', async () => {
    const s = await request(http).get(`/api/v1/shop/stores/${storeA}/ai/status`).set(auth(a.token)).expect(200);
    for (let i = s.body.used; i < s.body.limit; i++) await chat(a.token, storeA, { conversationId: conv, message: `س ${i}` }).expect(200);
    const r = await request(http).post(`/api/v1/shop/stores/${storeA}/ai/chat`).set(auth(a.token)).send({ message: 'واحد آخر' }).expect(429);
    expect(JSON.stringify(r.body)).toContain('AI_QUOTA');
    // المحادثة الجديدة التي رُفضت لا تبقى فارغة في القائمة
    const list = await request(http).get(`/api/v1/shop/stores/${storeA}/ai/conversations`).set(auth(a.token)).expect(200);
    expect(list.body.every((c: { messageCount: number }) => c.messageCount > 0)).toBe(true);
  });

  it('إعادة التسمية والحذف', async () => {
    const r = await request(http).patch(`/api/v1/shop/stores/${storeA}/ai/conversations/${conv}`).set(auth(a.token)).send({ title: '  خطة رمضان  ' }).expect(200);
    expect(r.body.title).toBe('خطة رمضان');
    await request(http).delete(`/api/v1/shop/stores/${storeA}/ai/conversations/${conv}`).set(auth(a.token)).expect(200);
    await request(http).get(`/api/v1/shop/stores/${storeA}/ai/conversations/${conv}`).set(auth(a.token)).expect(404);
    expect(await prisma.aiMessage.count({ where: { conversationId: conv } })).toBe(0);
  });

  it('المزوّد غير المضبوط يُرفض بوضوح قبل أي شيء', async () => {
    fake.ready = false;
    const r = await request(http).post(`/api/v1/shop/stores/${storeA}/ai/chat`).set(auth(a.token)).send({ message: 'مرحبا' }).expect(503);
    expect(JSON.stringify(r.body)).toContain('AI_OFF');
    fake.ready = true;
  });
});
