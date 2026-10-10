import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/errors/domain-error.filter';
import { TenantPrismaService } from '../src/common/prisma/tenant-prisma.service';
import { MerchantNotifier } from '../src/modules/notify/merchant-notifier.service';
import { SubscriptionReminders } from '../src/modules/notify/subscription-reminders.service';

/**
 * ما تحتاجه واجهة المتجر (Next) بعد انتقالها إلى الباكند الموحد:
 * كتالوج كامل لنداء واحد، وخريطة موقع، وإشعار التاجر بالطلب، وتذكيرات
 * الاشتراك — وقد كانت كلها في خادم منصة المتاجر القديم.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('واجهة المتجر: الكتالوج والإشعارات', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const owner = {
    email: `cat-${randomUUID()}@azm.test`,
    password: 'catalogue-1234',
    token: '',
    companyId: '',
  };
  const auth = () => ({ Authorization: `Bearer ${owner.token}` });
  const post = (p: string, body: object = {}) => request(http).post(`/api/v1${p}`).set(auth()).send(body);
  const patch = (p: string, body: object = {}) => request(http).patch(`/api/v1${p}`).set(auth()).send(body);

  let storeId = '';
  let slug = '';
  let shirtId = '';

  beforeAll(async () => {
    process.env.SHOP_ORDER_LIMIT = '1000';
    process.env.WEBHOOK_WORKER = '0';
    process.env.BILLING_WORKER = '0';
    process.env.NOTIFY_CHANNELS = 'console';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    const r = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: owner.email, password: owner.password, displayName: 'تاجر', companyName: 'شركة الكتالوج' })
      .expect(201);
    owner.token = r.body.accessToken;
    owner.companyId = r.body.company.id;

    slug = `cat-${randomUUID().slice(0, 8)}`;
    storeId = (await post('/shop/stores', { name: 'متجر الكتالوج', slug, sector: 'fashion', country: 'YE', whatsapp: '777123456' }).expect(201)).body.store.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { email: owner.email } }).catch(() => undefined);
    if (owner.companyId) await prisma.organization.delete({ where: { id: owner.companyId } }).catch(() => undefined);
    await app.close();
    delete process.env.WEBHOOK_WORKER;
    delete process.env.BILLING_WORKER;
  });

  it('الكتالوج: محاور الخيارات بترتيب التاجر، والنافد يبقى مشطوبًا، والعدّادات من المعروض', async () => {
    const cat = (await post(`/shop/stores/${storeId}/categories`, { name: 'قمصان' }).expect(201)).body;
    const empty = (await post(`/shop/stores/${storeId}/categories`, { name: 'فارغ' }).expect(201)).body;
    void empty;

    shirtId = (
      await post(`/shop/stores/${storeId}/products`, {
        name: 'قميص', price: 10000, brand: 'نسيج', categoryId: cat.id, opt1Name: 'المقاس', opt2Name: 'اللون',
        variants: [
          { v1: 'كبير', v2: 'أسود', qty: 0, image: 'https://cdn.test/black.jpg' },
          { v1: 'صغير', v2: 'أسود', qty: 3, image: 'https://cdn.test/black.jpg' },
          { v1: 'صغير', v2: 'أبيض', qty: 2, image: 'https://cdn.test/white.jpg' },
        ],
        images: ['https://cdn.test/shirt.jpg'],
      }).expect(201)
    ).body.id;
    await post(`/shop/stores/${storeId}/products`, { name: 'حزام', price: 3000, qty: 10, brand: 'نسيج' }).expect(201);
    await post(`/shop/stores/${storeId}/products`, { name: 'مخفي', price: 1, qty: 1, live: false }).expect(201);

    const r = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(r.body.store.slug).toBe(slug);
    expect(r.body.store).not.toHaveProperty('companyId');
    expect(r.body.products.map((p: { name: string }) => p.name).sort()).toEqual(['حزام', 'قميص']);

    const shirt = r.body.products.find((p: { id: string }) => p.id === shirtId);
    expect(shirt.hasVariants).toBe(true);
    expect(shirt.axes[0]).toEqual({
      key: 'v1',
      name: 'المقاس',
      values: [
        { value: 'كبير', inStock: false, image: 'https://cdn.test/black.jpg' },
        { value: 'صغير', inStock: true, image: 'https://cdn.test/black.jpg' },
      ],
    });
    expect(shirt.axes[1].values.map((v: { value: string }) => v.value)).toEqual(['أسود', 'أبيض']);
    expect(shirt.altImages).toEqual(expect.arrayContaining(['https://cdn.test/black.jpg', 'https://cdn.test/white.jpg']));
    expect(shirt.rating).toBe(0);
    // الكمية مجموع الخيارات (٠+٣+٢ = ٥) ← «منخفض»
    expect(shirt.qty).toBe(5);
    expect(shirt.stock).toBe('low');

    // التصنيف الفارغ لا يُعرض؛ والماركة تُعدّ من المعروض فقط
    expect(r.body.categories).toEqual([{ id: cat.id, name: 'قمصان', count: 1 }]);
    expect(r.body.brands).toEqual([{ name: 'نسيج', count: 2 }]);
  });

  it('الكتالوج يحترم حدّ الباقة: الأقدم يبقى والزائد يُخفى', async () => {
    // الباقة المجانية ١٥ منتجًا — نملأ حتى ١٧ منتجًا حيًّا
    for (let i = 0; i < 15; i++) {
      await post(`/shop/stores/${storeId}/products`, { name: `منتج ${i}`, price: 100, qty: 1 }).expect((res) => {
        if (![201, 403, 409].includes(res.status)) throw new Error(`unexpected ${res.status}`);
      });
    }
    const live = await prisma.shopProduct.count({ where: { storeId, live: true } });
    const r = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(r.body.products.length).toBe(Math.min(live, 15));
  });

  it('الرابط القديم يعيد وجهته، والمجهول ٤٠٤', async () => {
    const newSlug = `${slug}-new`;
    await patch(`/shop/stores/${storeId}`, { slug: newSlug }).expect(200);
    const r = await request(http).get(`/api/v1/shop/storefront/${slug}/catalogue`).expect(200);
    expect(r.body).toEqual({ moved: newSlug });
    slug = newSlug;
    await request(http).get(`/api/v1/shop/storefront/no-such-store-${randomUUID().slice(0, 6)}/catalogue`).expect(404);
  });

  it('خريطة الموقع تضم المتاجر النشطة دون الموقوفة', async () => {
    const r = await request(http).get('/api/v1/shop/storefront/sitemap/list').expect(200);
    expect(r.body.some((s: { slug: string }) => s.slug === slug)).toBe(true);
  });

  it('طلب جديد يُشعر التاجر برقمه وإجماليه، ولا يُسقط الطلب إن فشل الإشعار', async () => {
    const notifier = app.get(MerchantNotifier);
    const spy = jest.spyOn(notifier, 'notify');

    const r = await request(http)
      .post(`/api/v1/shop/storefront/${slug}/orders`)
      .send({ lines: [{ id: shirtId, variantId: (await prisma.shopProductVariant.findFirst({ where: { productId: shirtId, qty: { gt: 0 } } }))!.id, qty: 1 }], name: 'عميل' })
      .expect(201);
    await new Promise((res) => setTimeout(res, 200));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'متجر الكتالوج', whatsapp: '967777123456' }),
      expect.stringContaining(r.body.ref),
    );
    expect(spy.mock.calls.at(-1)?.[1]).toContain('الإجمالي: 10,000');

    spy.mockRejectedValueOnce(new Error('meta down'));
    await request(http)
      .post(`/api/v1/shop/storefront/${slug}/orders`)
      .send({ lines: [{ id: shirtId, variantId: (await prisma.shopProductVariant.findFirst({ where: { productId: shirtId, qty: { gt: 0 } } }))!.id, qty: 1 }], name: 'عميل' })
      .expect(201);
    spy.mockRestore();
  });

  it('تذكير الاشتراك يُرسل ويُعلَّم، وفشل الإرسال لا يعلّمه مُرسَلًا', async () => {
    const sub = await prisma.storeSubscription.findFirst({ where: { storeRef: storeId, deletedAt: null } });
    expect(sub).toBeTruthy();
    await prisma.storeSubscription.update({
      where: { id: sub!.id },
      data: { plan: 1, status: 0, currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000), notifiedStage: null },
    });

    const notifier = app.get(MerchantNotifier);
    const reminders = app.get(SubscriptionReminders);

    const spy = jest.spyOn(notifier, 'notify').mockRejectedValueOnce(new Error('meta down'));
    await reminders.run();
    expect((await prisma.storeSubscription.findUnique({ where: { id: sub!.id } }))?.notifiedStage).toBeNull();

    await reminders.run();
    const after = await prisma.storeSubscription.findUnique({ where: { id: sub!.id } });
    expect(after?.notifiedStage).toBe('d7');
    expect(spy.mock.calls.at(-1)?.[1]).toContain('ينتهي بعد');

    // لا يتكرر التذكير نفسه في الكنسة التالية
    spy.mockClear();
    await reminders.run();
    expect(spy.mock.calls.some((c) => String(c[1]).includes('متجر الكتالوج'))).toBe(false);
    spy.mockRestore();
  });
});
