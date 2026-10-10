import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';

/**
 * رفع الصور: النوع الحقيقي من بصمة الملف لا من اسمه، الحجم، الأدوار،
 * إعادة الترميز (WebP بحدّ ١٦٠٠ بكسل)، مجلد المتجر، وأن الملفات المخزَّنة
 * عامة القراءة بأسماء غير قابلة للتخمين. التخزين هنا محلي دائمًا
 * (`NODE_ENV=test`) — لا يكتب الاختبار في حاوية R2 الحقيقية.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('رفع الصور', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'upload-pass-1234',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
    userId: '',
  });
  const owner = mk('owner');
  const guest = { email: `guest-${randomUUID()}@azm.test`, password: 'gst-pass-1234', token: '' };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // بصمة PNG وحدها — تجتاز فحص النوع، لكنها ليست صورة يُفكّ ترميزها.
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  /** صورة PNG حقيقية ٢٤٠٠×١٢٠٠ — أكبر من حدّ الضلع كي يظهر التصغير */
  let PNG = Buffer.alloc(0);
  let storeId = '';

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
    await request(http)
      .post('/api/v1/team/members')
      .set(auth(owner.token))
      .send({ email: guest.email, displayName: 'ضيف', password: guest.password, role: 9 })
      .expect(201);
    const r = await request(http).post('/api/v1/auth/login').send({ email: guest.email, password: guest.password, companyId: owner.companyId }).expect(200);
    guest.token = r.body.accessToken;

    PNG = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#9E2226' } }).png().toBuffer();
    const st = await request(http)
      .post('/api/v1/shop/stores')
      .set(auth(owner.token))
      .send({ name: `upload store ${randomUUID().slice(0, 6)}`, whatsapp: '777123456', country: 'YE' })
      .expect(201);
    storeId = st.body.store.id;
  });

  afterAll(async () => {
    for (const email of [owner.email, guest.email]) {
      await prisma.user.delete({ where: { email } }).catch(() => undefined);
    }
    if (owner.companyId) await prisma.organization.delete({ where: { id: owner.companyId } }).catch(() => undefined);
    await app.close();
  });

  it('يرفع صورة صالحة ويعيد رابطًا يعمل بلا مصادقة، بأسماء عشوائية', async () => {
    const r = await request(http)
      .post('/api/v1/uploads')
      .set(auth(owner.token))
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    expect(r.body.url).toContain(`/api/v1/files/${owner.companyId}/`);
    expect(r.body.name).not.toBe('logo.png');
    expect(r.body.mime).toBe('image/webp');

    const path = r.body.url.replace(/^https?:\/\/[^/]+/, '');
    const file = await request(http).get(path).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    // أُعيد ترميزها WebP وصُغّرت إلى ١٦٠٠ بكسل على أطول ضلع، بنسبتها
    const meta = await sharp(file.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(800);
  });

  it('بصمة سليمة فوق محتوى تالف تُرفض — ليست صورة', async () => {
    await request(http)
      .post('/api/v1/uploads')
      .set(auth(owner.token))
      .attach('file', PNG_MAGIC, { filename: 'broken.png', contentType: 'image/png' })
      .expect(400);
  });

  it('storeId يقبل متجر الشركة نفسها، ويرفض متجرًا غريبًا ومعرّفًا غير صالح', async () => {
    await request(http)
      .post(`/api/v1/uploads?storeId=${storeId}`)
      .set(auth(owner.token))
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(201);
    await request(http)
      .post(`/api/v1/uploads?storeId=${randomUUID()}`)
      .set(auth(owner.token))
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(404);
    await request(http)
      .post('/api/v1/uploads?storeId=not-a-uuid')
      .set(auth(owner.token))
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(400);
  });

  it('النوع الحقيقي من محتوى الملف لا من امتداده — نص متنكّر بامتداد jpg يُرفض', async () => {
    await request(http)
      .post('/api/v1/uploads')
      .set(auth(owner.token))
      .attach('file', Buffer.from('this is not an image'), { filename: 'fake.jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  it('ملف أكبر من ٥ ميغابايت يُرفض برسالة واضحة (٤١٣)', async () => {
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(6 * 1024 * 1024)]);
    await request(http)
      .post('/api/v1/uploads')
      .set(auth(owner.token))
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' })
      .expect(413);
  });

  it('بلا ملف مرفق يُرفض بخطأ واضح', async () => {
    await request(http).post('/api/v1/uploads').set(auth(owner.token)).expect(400);
  });

  it('الضيف (دون الموظف) لا يرفع', async () => {
    await request(http)
      .post('/api/v1/uploads')
      .set(auth(guest.token))
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(403);
  });

  it('اسم ملف عشوائي غير موجود يرجع ٤٠٤، ومحاولة الخروج من المجلد تُرفض', async () => {
    await request(http).get(`/api/v1/files/${owner.companyId}/${randomUUID()}.png`).expect(404);
    await request(http).get(`/api/v1/files/${owner.companyId}/..%2f..%2fpackage.json`).expect(404);
    await request(http).get(`/api/v1/files/not-a-uuid/x.png`).expect(404);
  });
});
