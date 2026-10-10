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
 * AZM — تجارة المتاجر: من إنشاء المتجر إلى الطلب والتحليلات
 *
 * يثبت: حدود الباقة تُفرض في الخادم، وأسعار الطلب من القاعدة، وحجز المخزون
 * ذرّي (لا بيع مزدوج)، والإلغاء يعيد المخزون، وعزل المتاجر بين الشركات، وما
 * يراه الزائر قائمة بيضاء، وتحويل الروابط القديمة، وإيقاف المتجر.
 *
 * ⚠ يتطلّب قاعدة تعمل، مثل بقية ملفات e2e.
 */
describe('تجارة المتاجر', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let http: App;

  const RUN = randomUUID().slice(0, 8);
  const mk = (label: string) => ({
    email: `${label}-${randomUUID()}@azm.test`,
    password: 'shop-pass-1234',
    displayName: label,
    companyName: `شركة ${label}`,
    token: '',
    companyId: '',
    userId: '',
  });
  const a = mk('alpha');
  const b = mk('beta');
  const staff = mk('staff');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let storeId = '';
  let slug = '';
  let productId = '';
  let variantProductId = '';
  let variantM = '';

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
    // كل الطلبات من عنوان واحد — نرفع حدّ المعدّل كي لا يقطع الاختبار نفسه
    process.env.SHOP_ORDER_LIMIT = '1000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(TenantPrismaService);
    http = app.getHttpServer() as App;

    await register(a);
    await register(b);
    await register(staff);
    await prisma.user.update({
      where: { id: staff.userId },
      data: { isPlatformStaff: true, platformRole: 2 },
    });
  });

  afterAll(async () => {
    for (const u of [a, b, staff]) {
      if (u.companyId) {
        await prisma.organization.delete({ where: { id: u.companyId } }).catch(() => undefined);
      }
      await prisma.user.delete({ where: { email: u.email } }).catch(() => undefined);
    }
    await app.close();
  });

  const post = (path: string, token: string, body: object = {}) =>
    request(http).post(`/api/v1${path}`).set(auth(token)).send(body);
  const get = (path: string, token: string) =>
    request(http).get(`/api/v1${path}`).set(auth(token));

  describe('المتجر', () => {
    it('يُنشأ المتجر الأول مجانيًا، ورقم واتساب يُوحَّد دوليًا', async () => {
      slug = `alpha-${RUN}`;
      const r = await post('/shop/stores', a.token, {
        name: 'متجر ألفا', slug, sector: 'perfumes', country: 'YE', whatsapp: '777123456', city: 'صنعاء',
      }).expect(201);
      storeId = r.body.store.id;
      expect(r.body.store.slug).toBe(slug);
      expect(r.body.store.plan).toBe('basic');
      expect(r.body.store.whatsapp).toBe('967777123456');
      expect(r.body.store.currency).toBe('ر.ي');
      expect(r.body.store.companyId).toBeUndefined();
    });

    it('المتجر الثاني يُرفض بلا خانة', async () => {
      const r = await post('/shop/stores', a.token, {
        name: 'متجر ثان', slug: `second-${RUN}`, whatsapp: '777123456',
      }).expect(409);
      expect(JSON.stringify(r.body)).toContain('NO_STORE_SLOT');
    });

    it('الرابط المحجوز للمنصة والمكرّر يُرفضان مع اقتراح', async () => {
      const reserved = await get('/shop/stores/slug/check?q=admin', b.token).expect(200);
      expect(reserved.body.ok).toBe(false);
      const taken = await get(`/shop/stores/slug/check?q=${slug}`, b.token).expect(200);
      expect(taken.body.ok).toBe(false);
      expect(taken.body.suggestion).toBeTruthy();
    });

    it('رقم واتساب غير صالح يُرفض', async () => {
      await post('/shop/stores', b.token, {
        name: 'متجر بيتا', slug: `beta-${RUN}`, whatsapp: '123',
      }).expect(400);
    });

    it('السكِن الإضافي حكر على برو', async () => {
      const r = await request(http)
        .patch(`/api/v1/shop/stores/${storeId}`)
        .set(auth(a.token))
        .send({ theme: 'midnight' })
        .expect(409);
      expect(JSON.stringify(r.body)).toContain('PLAN_LIMIT');
    });
  });

  describe('الكتالوج وحدود الباقة', () => {
    it('تصنيف عادي يُنشأ، وفرعي يُرفض على المجانية', async () => {
      const c = await post(`/shop/stores/${storeId}/categories`, a.token, { name: 'عطور' }).expect(201);
      const sub = await post(`/shop/stores/${storeId}/categories`, a.token, {
        name: 'فرعي', parentId: c.body.id,
      }).expect(409);
      expect(JSON.stringify(sub.body)).toContain('PLAN_LIMIT');
    });

    it('منتج بلا خيارات: المعرض يُقصّ إلى حدّ الباقة والغلاف أول صورة', async () => {
      const r = await post(`/shop/stores/${storeId}/products`, a.token, {
        name: 'عود ملكي', price: 25000, qty: 10, live: true,
        images: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
      }).expect(201);
      productId = r.body.id;
      expect(r.body.images).toEqual(['https://cdn.test/a.jpg']); // مجانية = صورة واحدة
      expect(r.body.image).toBe('https://cdn.test/a.jpg');
    });

    it('منتج بخيارات: الكمية مجموع الخيارات، وتُتجاهل qty المرسلة', async () => {
      const r = await post(`/shop/stores/${storeId}/products`, a.token, {
        name: 'قميص', price: 10000, qty: 999, opt1Name: 'المقاس',
        variants: [
          { v1: 'M', qty: 2 },
          { v1: 'L', qty: 3, price: 12000 },
          { v1: 'M', qty: 50 }, // مكرّر يُسقط
          { v1: '', v2: '' }, // فارغ يُسقط
        ],
      }).expect(201);
      variantProductId = r.body.id;
      expect(r.body.hasVariants).toBe(true);
      expect(r.body.variants).toHaveLength(2);
      expect(r.body.qty).toBe(5);
      variantM = r.body.variants.find((v: { v1: string }) => v.v1 === 'M').id;
    });

    it('الحدّ ١٠ منتجات للمجانية يُفرض في الخادم', async () => {
      // يوجد منتجان؛ نكمل إلى ١٠
      for (let i = 0; i < 8; i++) {
        await post(`/shop/stores/${storeId}/products`, a.token, {
          name: `منتج ${i}`, price: 1000, qty: 1,
        }).expect(201);
      }
      const r = await post(`/shop/stores/${storeId}/products`, a.token, {
        name: 'زائد', price: 1, qty: 1,
      }).expect(409);
      expect(JSON.stringify(r.body)).toContain('PLAN_LIMIT');
    });
  });

  describe('واجهة المتجر العامة', () => {
    it('تُرجع قائمة بيضاء بلا companyId، والمنتجات مُرقَّمة', async () => {
      const r = await request(http).get(`/api/v1/shop/storefront/${slug}?per=4`).expect(200);
      expect(r.body.store.slug).toBe(slug);
      expect(r.body.store.companyId).toBeUndefined();
      expect(r.body.products).toHaveLength(4);
      expect(r.body.total).toBe(10);
      expect(r.body.hasMore).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain(a.companyId);
    });

    it('البحث والفرز في الخادم', async () => {
      const q = await request(http)
        .get(`/api/v1/shop/storefront/${slug}/products?q=${encodeURIComponent('عود')}`)
        .expect(200);
      expect(q.body.products.map((p: { name: string }) => p.name)).toContain('عود ملكي');
      const sorted = await request(http)
        .get(`/api/v1/shop/storefront/${slug}/products?sort=high&per=48`)
        .expect(200);
      const prices = sorted.body.products.map((p: { price: number }) => p.price);
      expect(prices).toEqual([...prices].sort((x: number, y: number) => y - x));
    });

    it('منتج بخيارات يعرض المحاور والتسميات', async () => {
      const r = await request(http)
        .get(`/api/v1/shop/storefront/${slug}/products/${variantProductId}`)
        .expect(200);
      expect(r.body.product.axes[0].values).toEqual(['M', 'L']);
      expect(r.body.product.variants.find((v: { v1: string }) => v.v1 === 'L').price).toBe(12000);
      expect(r.body.product.variants[0].label).toBe('المقاس: M');
    });

    it('رابط مجهول ٤٠٤', async () => {
      await request(http).get('/api/v1/shop/storefront/no-such-shop-zz').expect(404);
    });
  });

  describe('الطلبات والمخزون', () => {
    let ref = '';
    let orderId = '';

    it('السعر من القاعدة لا من العميل، والمخزون يُحجز فورًا', async () => {
      const r = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: productId, qty: 2 }], name: 'عميل', phone: '0777000111' })
        .expect(201);
      ref = r.body.ref;
      expect(ref).toMatch(/^RS-[0-9A-Z]{5}$/);
      expect(r.body.total).toBe(50000);
      expect(r.body.wa).toContain('wa.me/967777123456');

      const p = await get(`/shop/stores/${storeId}/products/${productId}`, a.token).expect(200);
      expect(p.body.qty).toBe(8);
    });

    it('حقل price القادم من العميل مرفوض (whitelist)', async () => {
      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: productId, qty: 1, price: 1 }] })
        .expect(400);
    });

    it('العميل يُعرَّف بالجوال الموحّد: صيغتان لرقم واحد = عميل واحد', async () => {
      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: productId, qty: 1 }], name: 'عميل', phone: '777000111' })
        .expect(201);
      const c = await get(`/shop/stores/${storeId}/customers`, a.token).expect(200);
      const mine = c.body.customers.filter((x: { phone: string }) => x.phone === '967777000111');
      expect(mine).toHaveLength(1);
      expect(mine[0].ordersCount).toBe(2);
      expect(c.body.returning).toBe(1);
    });

    it('خيار بعينه: مخزونه وسعره، ونفاده يُرفض', async () => {
      const r = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: variantProductId, variantId: variantM, qty: 2 }] })
        .expect(201);
      expect(r.body.total).toBe(20000);
      const p = await get(`/shop/stores/${storeId}/products/${variantProductId}`, a.token).expect(200);
      expect(p.body.qty).toBe(3); // مجموع الخيارات بعد الحجز (M=0 · L=3)

      const out = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: variantProductId, variantId: variantM, qty: 1 }] })
        .expect(409);
      expect(JSON.stringify(out.body)).toContain('نفد');

      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: variantProductId, qty: 1 }] })
        .expect(400); // منتج بخيارات بلا اختيار
    });

    it('لا بيع مزدوج: طلبان متزامنان على آخر قطعة ينجح أحدهما فقط', async () => {
      // الحدّ ١٥ ممتلئ — نحرّر مكانًا بحذف منتج
      const list = await get(`/shop/stores/${storeId}/products`, a.token).expect(200);
      const victim = list.body.products.find((x: { name: string }) => x.name === 'منتج 0');
      await request(http).delete(`/api/v1/shop/stores/${storeId}/products/${victim.id}`).set(auth(a.token)).expect(200);
      const one = await post(`/shop/stores/${storeId}/products`, a.token, {
        name: 'قطعة أخيرة', price: 500, qty: 1,
      }).expect(201);

      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          request(http)
            .post(`/api/v1/shop/storefront/${slug}/orders`)
            .send({ lines: [{ id: one.body.id, qty: 1 }] }),
        ),
      );
      const ok = results.filter((r) => r.status === 201).length;
      expect(ok).toBe(1);
      const after = await get(`/shop/stores/${storeId}/products/${one.body.id}`, a.token).expect(200);
      expect(after.body.qty).toBe(0);
    });

    it('الإلغاء يعيد المخزون، والتأكيد لا يخصم، والانتقال غير المسموح يُرفض', async () => {
      const list = await get(`/shop/stores/${storeId}/orders`, a.token).expect(200);
      const order = list.body.orders.find((o: { ref: string }) => o.ref === ref);
      orderId = order.id;

      await request(http)
        .patch(`/api/v1/shop/stores/${storeId}/orders/${orderId}`)
        .set(auth(a.token)).send({ status: 1 }).expect(200);
      let p = await get(`/shop/stores/${storeId}/products/${productId}`, a.token).expect(200);
      expect(p.body.qty).toBe(7); // ٨ − ١ (الطلب الثاني) ولم يُخصم شيء عند التأكيد

      await request(http)
        .patch(`/api/v1/shop/stores/${storeId}/orders/${orderId}`)
        .set(auth(a.token)).send({ status: 3 }).expect(200);
      p = await get(`/shop/stores/${storeId}/products/${productId}`, a.token).expect(200);
      expect(p.body.qty).toBe(9); // أُعيد الطلب الأول (٢)

      await request(http)
        .patch(`/api/v1/shop/stores/${storeId}/orders/${orderId}`)
        .set(auth(a.token)).send({ status: 1 }).expect(409); // ملغى ← مؤكد ممنوع
    });

    it('الطلب المتابَع برقمه، وإيصال الدفع عند الاستلام يُرفض', async () => {
      const t = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${ref}`).expect(200);
      expect(t.body.ref).toBe(ref);
      expect(t.body.items[0].name).toBe('عود ملكي');
      expect(t.body.payMethod).toBe('cod');
      expect(t.body.payNote).toBe('');
      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders/${ref}/proof`)
        .attach('file', await receipt(), { filename: 'r.png', contentType: 'image/png' })
        .expect(400);
    });

    it('الدفع بالتحويل: يبدأ بانتظار، ثم إيصال، ثم يؤكّده التاجر', async () => {
      await request(http)
        .patch(`/api/v1/shop/stores/${storeId}`)
        .set(auth(a.token))
        .send({ payMethods: ['cod', 'bank'], payNote: 'حوّل إلى الكريمي ١٢٣' })
        .expect(200);
      const r = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: variantProductId, variantId: (await variantL()), qty: 1 }], payMethod: 'bank' })
        .expect(201);
      expect(r.body.payStatus).toBe(1);
      expect(r.body.payNote).toContain('الكريمي');

      // التتبّع يعرض تعليمات التحويل ما دام الدفع معلّقًا
      const before = await request(http).get(`/api/v1/shop/storefront/${slug}/orders/${r.body.ref}`).expect(200);
      expect(before.body.payStatus).toBe(1);
      expect(before.body.payNote).toContain('الكريمي');

      // رابط جاهز لا يُقبل — الإيصال صورة تُرفع
      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders/${r.body.ref}/proof`)
        .send({ image: 'https://evil.test/receipt.jpg' })
        .expect(400);
      // ولا يُرفع إيصال لطلب غير موجود
      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders/RS-NOPE1/proof`)
        .attach('file', await receipt(), { filename: 'r.png', contentType: 'image/png' })
        .expect(404);

      const up = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders/${r.body.ref}/proof`)
        .attach('file', await receipt(), { filename: 'r.png', contentType: 'image/png' })
        .expect(201);
      expect(up.body.ok).toBe(true);

      const list = await get(`/shop/stores/${storeId}/orders`, a.token).expect(200);
      const o = list.body.orders.find((x: { ref: string }) => x.ref === r.body.ref);
      expect(o.payStatus).toBe(2);
      expect(o.payProof).toMatch(/\.webp$/);
      const paid = await request(http)
        .patch(`/api/v1/shop/stores/${storeId}/orders/${o.id}/payment`)
        .set(auth(a.token)).send({ paid: true }).expect(200);
      expect(paid.body.payStatus).toBe(3);
    });

    /** صورة PNG حقيقية — الإيصال يُعاد ترميزه فلا تكفي بصمة الملف */
    function receipt() {
      return sharp({ create: { width: 600, height: 900, channels: 3, background: '#ffffff' } }).png().toBuffer();
    }

    async function variantL(): Promise<string> {
      const p = await get(`/shop/stores/${storeId}/products/${variantProductId}`, a.token).expect(200);
      return p.body.variants.find((v: { v1: string }) => v.v1 === 'L').id;
    }
  });

  describe('التوصيل', () => {
    it('رسم المنطقة يُطبَّق ويُجّانى فوق الحدّ، والمنطقة الغريبة تُرفض', async () => {
      const z = await post(`/shop/stores/${storeId}/zones`, a.token, { name: 'صنعاء', fee: 1000, freeOver: 30000 }).expect(201);
      const small = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: productId, qty: 1 }], zoneId: z.body.id })
        .expect(201);
      expect(small.body.delivery).toBe(1000);
      expect(small.body.total).toBe(26000);
      const big = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: productId, qty: 2 }], zoneId: z.body.id })
        .expect(201);
      expect(big.body.delivery).toBe(0);
      await request(http)
        .post(`/api/v1/shop/storefront/${slug}/orders`)
        .send({ lines: [{ id: productId, qty: 1 }], zoneId: randomUUID() })
        .expect(400);
    });
  });

  describe('العزل', () => {
    it('شركة أخرى لا ترى المتجر ولا طلباته ولا تكتب فيه', async () => {
      await get(`/shop/stores/${storeId}`, b.token).expect(404);
      await get(`/shop/stores/${storeId}/orders`, b.token).expect(404);
      await get(`/shop/stores/${storeId}/products`, b.token).expect(404);
      await post(`/shop/stores/${storeId}/products`, b.token, { name: 'تسلّل', price: 1 }).expect(404);
      const mine = await get('/shop/stores', b.token).expect(200);
      expect(mine.body.stores).toEqual([]);
    });

    it('لا وصول بلا جلسة إلى لوحة التاجر', async () => {
      await request(http).get(`/api/v1/shop/stores/${storeId}/orders`).expect(401);
    });
  });

  describe('التحليلات', () => {
    it('النظرة العامة والتحليلات تحسبان من الطلبات الفعلية', async () => {
      const o = await get(`/shop/stores/${storeId}/overview`, a.token).expect(200);
      expect(o.body.kpis.pending).toBeGreaterThan(0);
      expect(o.body.chart).toHaveLength(7);
      expect(o.body.capacity.max).toBe(10);

      const an = await get(`/shop/stores/${storeId}/analytics?days=30`, a.token).expect(200);
      expect(an.body.totals.orders).toBeGreaterThan(3);
      // المبيعات = مؤكدة/مكتملة فقط: طلب الدفع المؤكَّد لم يُؤكَّد حالةً، والملغى مستبعد
      expect(an.body.totals.soldOrders).toBe(0);
      expect(an.body.byStatus['3']).toBe(1);
      expect(an.body.series).toHaveLength(30);
      expect(an.body.lowStock.map((p: { name: string }) => p.name)).toContain('قطعة أخيرة');
    });

    it('الزيارة الفريدة تُحسب مرة واحدة يوميًا للبصمة نفسها', async () => {
      const first = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/visit`).set('User-Agent', 'jest').expect(201);
      const again = await request(http)
        .post(`/api/v1/shop/storefront/${slug}/visit`).set('User-Agent', 'jest').expect(201);
      expect(first.body.counted).toBe(true);
      expect(again.body.counted).toBe(false);
      const o = await get(`/shop/stores/${storeId}/overview`, a.token).expect(200);
      expect(o.body.kpis.visits).toBe(1);
    });
  });

  describe('الرابط والإيقاف', () => {
    it('تغيير الرابط يحفظ القديم ويحوّل إليه، ولا يأخذه تاجر آخر', async () => {
      const newSlug = `alpha-new-${RUN}`;
      await request(http)
        .patch(`/api/v1/shop/stores/${storeId}`)
        .set(auth(a.token)).send({ slug: newSlug }).expect(200);

      const old = await request(http).get(`/api/v1/shop/storefront/${slug}`).expect(200);
      expect(old.body.moved).toBe(newSlug);

      const taken = await get(`/shop/stores/slug/check?q=${slug}`, b.token).expect(200);
      expect(taken.body.ok).toBe(false);
      slug = newSlug;
    });

    it('الإيقاف: الزائر ٤١٠ والتاجر لا يكتب، والرفع يعيد كل شيء', async () => {
      await request(http)
        .patch(`/api/v1/platform/shop-stores/${storeId}/status`)
        .set(auth(staff.token)).send({ suspended: true }).expect(200);
      await request(http).get(`/api/v1/shop/storefront/${slug}`).expect(410);
      await post(`/shop/stores/${storeId}/products`, a.token, { name: 'x', price: 1 }).expect(403);
      // التاجر العادي لا يصل إلى مسار الإدارة
      await request(http)
        .patch(`/api/v1/platform/shop-stores/${storeId}/status`)
        .set(auth(a.token)).send({ suspended: false }).expect(403);

      await request(http)
        .patch(`/api/v1/platform/shop-stores/${storeId}/status`)
        .set(auth(staff.token)).send({ suspended: false }).expect(200);
      await request(http).get(`/api/v1/shop/storefront/${slug}`).expect(200);
    });

    it('حذف المتجر الوحيد يُرفض، وحذف الاشتراك يتبعه', async () => {
      const r = await request(http)
        .delete(`/api/v1/shop/stores/${storeId}`).set(auth(a.token)).expect(409);
      expect(JSON.stringify(r.body)).toContain('LAST_STORE');
    });
  });
});
