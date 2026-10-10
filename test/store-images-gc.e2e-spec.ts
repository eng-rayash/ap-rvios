import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { StoreImagesGc } from '../src/modules/uploads/store-images-gc.service';
import { UploadsService } from '../src/modules/uploads/uploads.service';

/**
 * منظّف صور المتاجر: يحذف من مجلد المتجر ما لم يعد مستعملًا، ويُبقي ما يشير
 * إليه المتجر أو منتجاته أو خياراته، والإيصالات دائمًا، والأحدث من المهلة.
 *
 * تخزين وهمي بدل R2 — الاختبار لا يلمس الحاوية الحقيقية.
 */
describe('منظّف صور المتاجر', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;
  let gc: StoreImagesGc;

  const BASE = 'https://pub-test.r2.dev';
  const objects = new Map<string, Date>();
  const removed: string[] = [];
  const fakeR2 = {
    keyOf: (url: string) => (url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : null),
    list: async (prefix: string) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, modified]) => ({ key, modified })),
    remove: async (keys: string[]) => { for (const k of keys) { objects.delete(k); removed.push(k); } },
  };

  const u = { email: `gc-${randomUUID()}@azm.test`, password: 'gc-pass-12345', token: '', companyId: '' };
  const auth = () => ({ Authorization: `Bearer ${u.token}` });
  let storeId = '';
  const url = (name: string) => `${BASE}/stores/${storeId}/${name}`;
  const old = new Date(Date.now() - 2 * 60 * 60_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;
    gc = app.get(StoreImagesGc);
    Object.defineProperty(app.get(UploadsService), 'cloud', { get: () => fakeR2 });

    const r = await request(http).post('/api/v1/auth/register')
      .send({ email: u.email, password: u.password, displayName: 'gc', companyName: 'شركة الكنس' }).expect(201);
    u.token = r.body.accessToken;
    u.companyId = r.body.company.id;
    const st = await request(http).post('/api/v1/shop/stores').set(auth())
      .send({ name: 'متجر الكنس', slug: `gc-${randomUUID().slice(0, 6)}`, whatsapp: '777123456', country: 'YE' }).expect(201);
    storeId = st.body.store.id;
  });

  afterAll(async () => {
    if (u.companyId) await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
    await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    await app.close();
  });

  it('يحذف اليتيم القديم وحده — ويُبقي المستعمل والإيصال والحديث', async () => {
    for (const n of ['logo.webp', 'product.webp', 'variant.webp', 'gone.webp', 'receipt.webp']) objects.set(`stores/${storeId}/${n}`, old);
    objects.set(`stores/${storeId}/fresh.webp`, new Date()); // رُفعت لتوّها ولم تُحفظ بعد
    objects.set(`stores/other-store/x.webp`, old); // متجر آخر — خارج المجلد

    await request(http).patch(`/api/v1/shop/stores/${storeId}`).set(auth()).send({ logo: url('logo.webp') }).expect(200);
    await request(http).post(`/api/v1/shop/stores/${storeId}/products`).set(auth())
      .send({ name: 'منتج', price: 100, image: url('product.webp'), opt1Name: 'المقاس', variants: [{ v1: 'M', qty: 1, image: url('variant.webp') }] }).expect(201);
    await prisma.platformInvoice.create({
      data: { syncId: randomUUID(), companyId: u.companyId, invoiceNumber: `RV-INV-GC${Date.now()}`.slice(0, 20), amount: 6, currency: 'USD',
        periodStart: '2026-01-01', periodEnd: '2026-02-01', kind: 0, storeRef: storeId, proofKey: url('receipt.webp') },
    });

    const n = await gc.sweep(storeId);
    expect(n).toBe(1);
    expect(removed).toEqual([`stores/${storeId}/gone.webp`]);
    expect([...objects.keys()].sort()).toEqual([
      `stores/${storeId}/fresh.webp`, `stores/${storeId}/logo.webp`, `stores/${storeId}/product.webp`,
      `stores/${storeId}/receipt.webp`, `stores/${storeId}/variant.webp`, 'stores/other-store/x.webp',
    ].sort());
  });

  it('حذف المتجر: كل صوره بلا مهلة — عدا إيصال الفاتورة', async () => {
    removed.length = 0;
    await prisma.shopProduct.deleteMany({ where: { storeId } });
    await prisma.shopStore.update({ where: { id: storeId }, data: { logo: '' } });
    const n = await gc.sweep(storeId, { grace: 0 });
    expect(n).toBe(4);
    expect([...objects.keys()].filter((k) => k.startsWith(`stores/${storeId}/`))).toEqual([`stores/${storeId}/receipt.webp`]);
  });
});
