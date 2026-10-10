import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { isPrivateAddress } from '../src/modules/webhooks/url-guard';
import { MAX_ATTEMPTS } from '../src/modules/webhooks/webhooks.constants';
import { WebhooksService } from '../src/modules/webhooks/webhooks.service';

/**
 * خطافات الويب: إرسال حقيقي عبر HTTP إلى مستقبِل محلي يتحقق من التوقيع.
 *
 * يثبت: أحداث الطلبات تصل موقَّعة بـHMAC يطابق السرّ، والحدث غير المشترَك
 * فيه لا يُرسَل، والفشل يُجدول لإعادة المحاولة ولا يُسقط الطلب، وإعادة
 * الإرسال تعمل، والحماية من SSRF، وعزل الشركات، وحدود الأدوار.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('خطافات الويب', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  // ─── مستقبِل محلي ───
  interface Received {
    path: string;
    headers: IncomingMessage['headers'];
    body: string;
  }
  let receiver: Server;
  let base = '';
  const received: Received[] = [];
  /** رمز الردّ لكل مسار — لمحاكاة مستقبِل معطَّل */
  const replyWith = new Map<string, number>();

  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'hook-pass-1234',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
  });
  const owner = mk('owner');
  const other = mk('other');
  const emp = { email: `emp-${randomUUID()}@azm.test`, password: 'emp-pass-1234', token: '' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let storeId = '';
  let slug = '';
  let productId = '';

  const post = (p: string, t: string, body: object = {}) => request(http).post(`/api/v1${p}`).set(auth(t)).send(body);
  const patch = (p: string, t: string, body: object = {}) => request(http).patch(`/api/v1${p}`).set(auth(t)).send(body);
  const get = (p: string, t: string) => request(http).get(`/api/v1${p}`).set(auth(t));
  const del = (p: string, t: string) => request(http).delete(`/api/v1${p}`).set(auth(t));

  /** ينتظر حتى يصل طلب يطابق الشرط (الإرسال يجري بعد ردّ API). */
  async function waitFor(pred: (r: Received) => boolean, ms = 6000): Promise<Received> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = received.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('لم يصل الخطاف المنتظَر');
  }

  function verify(r: Received, secret: string) {
    const header = String(r.headers['x-azm-signature']);
    const [tPart, vPart] = header.split(',');
    const t = tPart.replace('t=', '');
    const expected = createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex');
    return vPart === `v1=${expected}`;
  }

  async function register(u: ReturnType<typeof mk>) {
    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: u.displayName, companyName: u.companyName })
      .expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
  }

  async function placeOrder() {
    const r = await request(http)
      .post(`/api/v1/shop/storefront/${slug}/orders`)
      .send({ lines: [{ id: productId, qty: 1 }], name: 'عميل الخطاف', phone: '0777000222' })
      .expect(201);
    return r.body.ref as string;
  }

  beforeAll(async () => {
    process.env.SHOP_ORDER_LIMIT = '1000';
    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    process.env.WEBHOOK_WORKER = '0'; // الإرسال الفوري فقط — لا عامل خلفي يتسابق مع الاختبار

    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.statusCode = replyWith.get(req.url ?? '') ?? 200;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

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
    emp.token = (
      await request(http).post('/api/v1/auth/login').send({ email: emp.email, password: emp.password, companyId: owner.companyId }).expect(200)
    ).body.accessToken;

    slug = `hooks-${randomUUID().slice(0, 8)}`;
    storeId = (await post('/shop/stores', owner.token, { name: 'متجر الخطافات', slug, sector: 'perfumes', country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    productId = (await post(`/shop/stores/${storeId}/products`, owner.token, { name: 'عطر', price: 10000, qty: 100, live: true }).expect(201)).body.id;
  });

  afterAll(async () => {
    for (const email of [owner.email, other.email, emp.email]) {
      await prisma.user.delete({ where: { email } }).catch(() => undefined);
    }
    for (const id of [owner.companyId, other.companyId]) {
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
    await new Promise((r) => receiver.close(r));
    delete process.env.WEBHOOK_WORKER;
  });

  let hookId = '';
  let secret = '';

  it('المدير ينشئ نقطة، والسرّ يظهر مرة واحدة فقط', async () => {
    const r = await post('/developer/webhooks', owner.token, { url: `${base}/orders`, events: ['order.created'] }).expect(201);
    hookId = r.body.id;
    secret = r.body.secret;
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    const list = await get('/developer/webhooks', owner.token).expect(200);
    expect(list.body[0]).not.toHaveProperty('secret');
    expect(list.body[0].secretHint).toBe(`whsec_…${secret.slice(-4)}`);
  });

  it('الموظف لا يدير الخطافات، والحدث المجهول مرفوض', async () => {
    await post('/developer/webhooks', emp.token, { url: `${base}/x`, events: ['order.created'] }).expect(403);
    await post('/developer/webhooks', owner.token, { url: `${base}/x`, events: ['user.hacked'] }).expect(400);
    await post('/developer/webhooks', owner.token, { url: `${base}/x`, events: [] }).expect(400);
  });

  it('حماية SSRF: بلا إذن صريح تُرفض العناوين الداخلية وhttp', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = '0';
    try {
      await post('/developer/webhooks', owner.token, { url: `${base}/x`, events: ['order.created'] }).expect(400);
      await post('/developer/webhooks', owner.token, { url: 'https://127.0.0.1/x', events: ['order.created'] }).expect(400);
      await post('/developer/webhooks', owner.token, { url: 'https://169.254.169.254/latest', events: ['order.created'] }).expect(400);
      await post('/developer/webhooks', owner.token, { url: 'https://user:pw@example.com/x', events: ['order.created'] }).expect(400);
      await post('/developer/webhooks', owner.token, { url: 'ftp://example.com', events: ['order.created'] }).expect(400);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    }
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('172.20.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('طلب حقيقي من واجهة المتجر يصل موقَّعًا توقيعًا صحيحًا', async () => {
    const ref = await placeOrder();
    const hit = await waitFor((r) => r.path === '/orders' && r.body.includes(ref));
    expect(hit.headers['x-azm-event']).toBe('order.created');
    expect(hit.headers['content-type']).toContain('application/json');
    expect(verify(hit, secret)).toBe(true);
    expect(verify(hit, 'whsec_wrong')).toBe(false);

    const body = JSON.parse(hit.body);
    expect(body.event).toBe('order.created');
    expect(body.id).toBe(hit.headers['x-azm-delivery']);
    expect(body.data.ref).toBe(ref);
    expect(body.data.total).toBe(10000);
    expect(body.data.items[0].name).toBe('عطر');
    expect(body.data.store.slug).toBe(slug);
    expect(body.data).not.toHaveProperty('companyId');
  });

  it('حدث غير مشترَك فيه لا يُرسل، ويُرسل بعد إضافة الاشتراك', async () => {
    const ref = await placeOrder();
    await waitFor((r) => r.body.includes(ref) && r.headers['x-azm-event'] === 'order.created');
    const orders = await get(`/shop/stores/${storeId}/orders`, owner.token).expect(200);
    const order = orders.body.orders.find((o: { ref: string }) => o.ref === ref);

    const before = received.length;
    await patch(`/shop/stores/${storeId}/orders/${order.id}`, owner.token, { status: 1 }).expect(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(received.slice(before).some((r) => r.headers['x-azm-event'] === 'order.status_changed')).toBe(false);

    await patch(`/developer/webhooks/${hookId}`, owner.token, { events: ['order.created', 'order.status_changed'] }).expect(200);
    await patch(`/shop/stores/${storeId}/orders/${order.id}`, owner.token, { status: 2 }).expect(200);
    const hit = await waitFor((r) => r.headers['x-azm-event'] === 'order.status_changed' && r.body.includes(ref));
    const body = JSON.parse(hit.body);
    expect(body.data.status).toBe(2);
    expect(body.data.previousStatus).toBe(1);
    expect(verify(hit, secret)).toBe(true);
  });

  it('الحدث التجريبي يعيد نتيجة الإرسال فورًا', async () => {
    const r = await post(`/developer/webhooks/${hookId}/test`, owner.token).expect(200);
    expect(r.body.status).toBe(1);
    expect(r.body.responseCode).toBe(200);
    const hit = await waitFor((x) => x.headers['x-azm-delivery'] === r.body.id);
    expect(hit.headers['x-azm-event']).toBe('webhook.test');
  });

  it('فشل المستقبِل يُجدول إعادة محاولة ولا يُسقط الطلب، وإعادة الإرسال تنجح بعد الإصلاح', async () => {
    const h = await post('/developer/webhooks', owner.token, { url: `${base}/down`, events: ['order.created'] }).expect(201);
    replyWith.set('/down', 500);

    const ref = await placeOrder(); // ٢٠١ رغم فشل المستقبِل
    await waitFor((r) => r.path === '/down' && r.body.includes(ref));
    await new Promise((r) => setTimeout(r, 300));

    const log = await get(`/developer/webhooks/${h.body.id}/deliveries`, owner.token).expect(200);
    const failed = log.body[0];
    expect(failed.status).toBe(0); // لا يزال بانتظار إعادة المحاولة
    expect(failed.attempts).toBe(1);
    expect(failed.responseCode).toBe(500);
    expect(new Date(failed.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 30_000);

    const list = await get('/developer/webhooks', owner.token).expect(200);
    expect(list.body.find((x: { id: string }) => x.id === h.body.id).failureCount).toBe(1);

    replyWith.set('/down', 200);
    const re = await post(`/developer/webhooks/deliveries/${failed.id}/redeliver`, owner.token).expect(200);
    expect(re.body.status).toBe(1);
    expect(re.body.id).not.toBe(failed.id);
    const after = await get('/developer/webhooks', owner.token).expect(200);
    expect(after.body.find((x: { id: string }) => x.id === h.body.id).failureCount).toBe(0);

    await del(`/developer/webhooks/${h.body.id}`, owner.token).expect(200);
  });

  it('العامل الخلفي يعيد المستحق، ويتوقف نهائيًا بعد آخر محاولة', async () => {
    const svc = app.get(WebhooksService);
    const h = await post('/developer/webhooks', owner.token, { url: `${base}/flaky`, events: ['order.created'] }).expect(201);
    replyWith.set('/flaky', 503);
    const ref = await placeOrder();
    await waitFor((r) => r.path === '/flaky' && r.body.includes(ref));
    await new Promise((r) => setTimeout(r, 300));

    const [d] = (await get(`/developer/webhooks/${h.body.id}/deliveries`, owner.token)).body;
    // المحاولة التالية مستحقة الآن (بدل انتظار دقيقة)، والمستقبِل عاد للعمل
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    replyWith.set('/flaky', 200);
    await svc.sweep();
    const ok = await prisma.webhookDelivery.findUnique({ where: { id: d.id } });
    expect(ok?.status).toBe(1);
    expect(ok?.attempts).toBe(2);

    // مستقبِل ميت: عند المحاولة الأخيرة يصير «فشل نهائيًا» ولا يُعاد
    replyWith.set('/flaky', 500);
    const ref2 = await placeOrder();
    await waitFor((r) => r.path === '/flaky' && r.body.includes(ref2));
    await new Promise((r) => setTimeout(r, 300));
    const [d2] = (await get(`/developer/webhooks/${h.body.id}/deliveries`, owner.token)).body;
    await prisma.webhookDelivery.update({
      where: { id: d2.id },
      data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await svc.sweep();
    const dead = await prisma.webhookDelivery.findUnique({ where: { id: d2.id } });
    expect(dead?.status).toBe(2);
    expect(dead?.nextAttemptAt).toBeNull();

    await del(`/developer/webhooks/${h.body.id}`, owner.token).expect(200);
  });

  it('نقطة معطّلة لا يصلها شيء', async () => {
    const h = await post('/developer/webhooks', owner.token, { url: `${base}/off`, events: ['order.created'] }).expect(201);
    await patch(`/developer/webhooks/${h.body.id}`, owner.token, { isActive: false }).expect(200);
    await placeOrder();
    await new Promise((r) => setTimeout(r, 500));
    expect(received.some((r) => r.path === '/off')).toBe(false);
  });

  it('تدوير السرّ: التوقيع التالي بالسرّ الجديد لا القديم', async () => {
    const r = await post(`/developer/webhooks/${hookId}/rotate-secret`, owner.token).expect(200);
    expect(r.body.secret).not.toBe(secret);
    const t = await post(`/developer/webhooks/${hookId}/test`, owner.token).expect(200);
    const hit = await waitFor((x) => x.headers['x-azm-delivery'] === t.body.id);
    expect(verify(hit, r.body.secret)).toBe(true);
    expect(verify(hit, secret)).toBe(false);
  });

  it('شركة أخرى لا ترى نقاطنا ولا سجلاتها ولا تختبرها أو تحذفها', async () => {
    const mine = await get('/developer/webhooks', other.token).expect(200);
    expect(mine.body).toHaveLength(0);
    await get(`/developer/webhooks/${hookId}/deliveries`, other.token).expect(404);
    await post(`/developer/webhooks/${hookId}/test`, other.token).expect(404);
    await patch(`/developer/webhooks/${hookId}`, other.token, { isActive: false }).expect(404);
    await del(`/developer/webhooks/${hookId}`, other.token).expect(404);
  });
});
