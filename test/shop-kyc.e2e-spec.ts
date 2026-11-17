import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { ShopKycService } from '../src/modules/shop/kyc/kyc';

/** توثيق المتجر: الوثائق خاصة (لا رابط عام، ولا EXIF)، ومراجعة المنصة تمنح الشارة، والصور تُحذف بعد المهلة. */
describe('توثيق المتجر', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  const RUN = randomUUID().slice(0, 8);
  const mk = (p: string) => ({ email: `${p}-${randomUUID()}@azm.test`, token: '', companyId: '', userId: '' });
  const owner = mk('kyc');
  const other = mk('kyc2');
  const staff = mk('kyc-staff');
  let storeId = '';
  let slug = '';
  let png: Buffer;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const base = () => `/api/v1/shop/stores/${storeId}/kyc`;

  async function reg(x: typeof owner) {
    const r = await request(http).post('/api/v1/auth/register').send({ email: x.email, password: 'kyc-pass-12345', displayName: 'تاجر التوثيق', companyName: 'شركة التوثيق' }).expect(201);
    x.token = r.body.accessToken;
    x.companyId = r.body.company.id;
    x.userId = r.body.user.id;
  }
  const upload = (kind: string, t = owner.token) => request(http).post(`${base()}/docs?kind=${kind}`).set(auth(t)).attach('file', png, { filename: 'id.png', contentType: 'image/png' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    for (const x of [owner, other, staff]) await reg(x);
    await prisma.user.update({ where: { id: staff.userId }, data: { isPlatformStaff: true, platformRole: 2 } });
    slug = `kyc-${RUN}`;
    storeId = (await request(http).post('/api/v1/shop/stores').set(auth(owner.token)).send({ name: 'متجر التوثيق', slug, country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
    // صورة بموقع GPS في EXIF — يجب ألّا يبقى منه شيء
    png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#c1272d' } })
      .withExif({ IFD0: { Copyright: 'secret-location-marker' } }).png().toBuffer();
  });

  afterAll(async () => {
    for (const x of [owner, other, staff]) {
      if (x.companyId) await prisma.organization.delete({ where: { id: x.companyId } }).catch(() => undefined);
      await prisma.user.delete({ where: { email: x.email } }).catch(() => undefined);
    }
    await app.close();
  });

  it('التاجر يرفع وثائقه ويقدّم؛ الشروط تُفحص، والصورة تُقرأ لصاحبها فقط وبلا بيانات وصفية', async () => {
    const empty = await request(http).get(base()).set(auth(owner.token)).expect(200);
    expect(empty.body.status).toBeNull();
    await request(http).put(base()).set(auth(owner.token)).send({ kind: 'business', legalName: 'مؤسسة الاختبار التجارية' }).expect(200);
    const up = await upload('id_front').expect(201);
    expect(up.body.docs).toHaveLength(1);
    await upload('id_front').expect(201); // الاستبدال لا التكرار
    await upload('passport_scan').expect(400);
    // منشأة بلا سجل تجاري لا تُقدَّم
    const bad = await request(http).post(`${base()}/submit`).set(auth(owner.token)).expect(400);
    expect(JSON.stringify(bad.body)).toContain('السجل التجاري');
    await request(http).put(base()).set(auth(owner.token)).send({ kind: 'business', legalName: 'مؤسسة الاختبار التجارية', crNumber: 'CR-1234' }).expect(200);
    const last = await upload('cr').expect(201);
    expect(last.body.docs.map((d: { kind: string }) => d.kind).sort()).toEqual(['cr', 'id_front']);

    const docId = last.body.docs[0].id as string;
    const img = await request(http).get(`${base()}/docs/${docId}`).set(auth(owner.token)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(img.headers['content-type']).toContain('image/webp');
    expect(img.headers['cache-control']).toContain('no-store');
    const meta = await sharp(img.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    // شركة أخرى لا تراها، ولا يراها مسار المنصة لغير فريقها
    await request(http).get(`${base()}/docs/${docId}`).set(auth(other.token)).expect(404);

    await request(http).post(`${base()}/submit`).set(auth(owner.token)).expect(201);
    // المعلّق مغلق على التعديل
    await upload('selfie').expect(409);
  });

  it('المنصة ترفض بسبب، ثم يصحّح التاجر ويعيد، فتقبل: الشارة تظهر للعموم', async () => {
    await request(http).get('/api/v1/platform/kyc').set(auth(owner.token)).expect(403);
    const list = await request(http).get('/api/v1/platform/kyc?status=1').set(auth(staff.token)).expect(200);
    const req = list.body.requests.find((r: { storeId: string }) => r.storeId === storeId);
    expect(req.store.name).toBe('متجر التوثيق');
    expect(req.docs).toHaveLength(2);
    expect(req).not.toHaveProperty('docs.0.data');
    const doc = await request(http).get(`/api/v1/platform/kyc/${req.id}/docs/${req.docs[0].id}`).set(auth(staff.token)).expect(200);
    expect(doc.headers['content-type']).toContain('image/webp');

    await request(http).post(`/api/v1/platform/kyc/${req.id}/decide`).set(auth(staff.token)).send({ approve: false }).expect(400);
    await request(http).post(`/api/v1/platform/kyc/${req.id}/decide`).set(auth(staff.token)).send({ approve: false, note: 'صورة الهوية غير واضحة' }).expect(201);
    const mine = await request(http).get(base()).set(auth(owner.token)).expect(200);
    expect(mine.body.status).toBe(3);
    expect(mine.body.reviewNote).toBe('صورة الهوية غير واضحة');

    await upload('id_front').expect(201);
    await request(http).post(`${base()}/submit`).set(auth(owner.token)).expect(201);
    await request(http).post(`/api/v1/platform/kyc/${req.id}/decide`).set(auth(staff.token)).send({ approve: true }).expect(201);
    await request(http).post(`/api/v1/platform/kyc/${req.id}/decide`).set(auth(staff.token)).send({ approve: true }).expect(409);
    const done = await request(http).get(base()).set(auth(owner.token)).expect(200);
    expect(done.body.status).toBe(2);
    expect(done.body.verified).toBe(true);
    const pub = await request(http).get(`/api/v1/shop/storefront/${slug}`).expect(200);
    expect(JSON.stringify(pub.body)).toContain('"verified":true');
    // الموثَّق لا يُعدَّل
    await upload('selfie').expect(409);
  });

  it('صور الوثائق تُحذف بعد ٣٠ يومًا من القرار ويبقى القرار', async () => {
    const svc = app.get(ShopKycService);
    expect(await svc.purge(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(await svc.purge(new Date(Date.now() + 31 * 86_400_000))).toBeGreaterThan(0);
    const after = await request(http).get(base()).set(auth(owner.token)).expect(200);
    expect(after.body.docs).toHaveLength(0);
    expect(after.body.status).toBe(2);
  });
});
