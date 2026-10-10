import { PLAN_BY_CODE, PUBLIC_PLAN } from '../../shop-billing/shop-billing.constants';
import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShopProduct, ShopStore } from '@prisma/client';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { ShopReviewsService } from '../reviews/reviews.service';
import { normalizeDomain } from '../domain.util';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { variantLabel, variantPrice } from '../catalog/catalog.service';
import { waAsk } from '../orders/order-message';
import { PAY_METHODS, StoreStatus, limitsOf, symbolOf } from '../shop.constants';
import { storeView } from '../stores/stores.service';

/** نتيجة حلّ رابط: متجر حيّ، أو تحويل دائم إلى رابطه الجديد. */
export type Resolved =
  | { kind: 'ok'; store: ShopStore; plan: string }
  | { kind: 'moved'; to: string };

const SORTS: Record<string, Prisma.ShopProductOrderByWithRelationInput[]> = {
  new: [{ sort: 'asc' }, { createdAt: 'desc' }],
  low: [{ price: 'asc' }, { createdAt: 'desc' }],
  high: [{ price: 'desc' }, { createdAt: 'desc' }],
  name: [{ name: 'asc' }],
};

/**
 * واجهة المتجر العامة (§٣.٤) — بلا جلسة.
 *
 * استثناء موثَّق من العزل التلقائي: الزائر لا يحمل شركة، فيُحلّ المتجر بـ
 * `slug` عبر العميل الأساس (الرابط فريد عالميًا)، ثم كل ما بعده مقيَّد
 * بـ`storeId` المحلول. ما يُكشف للعميل النهائي قائمة بيضاء صريحة — لا
 * `companyId` ولا حقول داخلية.
 */
@Injectable()
export class ShopPublicService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly reviews: ShopReviewsService,
  ) {}

  /** يجلب متجرًا نشطًا بالرابط. الموقوف ٤١٠، والمجهول ٤٠٤، والقديم تحويل. */
  async resolve(slug: string): Promise<Resolved> {
    const store = await this.prisma.shopStore.findUnique({ where: { slug } });
    if (!store) {
      const old = await this.prisma.shopSlugHistory.findUnique({ where: { oldSlug: slug } });
      if (old) {
        const current = await this.prisma.shopStore.findUnique({ where: { id: old.storeId } });
        if (current && current.status === StoreStatus.Active) {
          return { kind: 'moved', to: current.slug };
        }
      }
      throw new NotFoundException('لا يوجد متجر بهذا الرابط');
    }
    if (store.status === StoreStatus.Suspended) {
      throw new GoneException('هذا المتجر موقوف مؤقتًا');
    }
    const plan = await this.access.planOf(store.companyId, store.id);
    return { kind: 'ok', store, plan };
  }

  /**
   * النطاق الخاص ← رابط المتجر، لـ middleware منصة المتاجر. يُحلّ فقط لمتجر
   * نشط على باقة مدفوعة — هبوط الباقة يوقف النطاق دون أن يمسح ربطه.
   */
  async slugForDomain(host: string): Promise<{ slug: string }> {
    const domain = normalizeDomain(host);
    const store = domain ? await this.prisma.shopStore.findUnique({ where: { customDomain: domain } }) : null;
    if (!store || store.status === StoreStatus.Suspended) throw new NotFoundException('لا متجر على هذا النطاق');
    const plan = await this.access.planOf(store.companyId, store.id);
    if (plan === 'basic') throw new NotFoundException('لا متجر على هذا النطاق');
    return { slug: store.slug };
  }

  /** متجر حيّ أو خطأ — للمسارات التي لا تعنيها التحويلات. */
  async live(slug: string): Promise<{ store: ShopStore; plan: string }> {
    const r = await this.resolve(slug);
    if (r.kind === 'moved') throw new NotFoundException('لا يوجد متجر بهذا الرابط');
    return r;
  }

  private publicStore(store: ShopStore, plan: string) {
    // قائمة بيضاء: لا companyId ولا حالة داخلية
    const v = storeView(store, plan);
    return {
      id: v.id, slug: v.slug, name: v.name, sector: v.sector,
      tagline: v.tagline, about: v.about, city: v.city, address: v.address,
      whatsapp: v.whatsapp, hours: v.hours, logo: v.logo, banner: v.banner,
      showcase: v.showcase, color: v.color, colorDeep: v.colorDeep,
      theme: v.theme, layout: v.layout, plan: v.plan, verified: v.verified,
      // منصة المتاجر الجديدة: القالب الفعّال، والباقة برموزها (free|pro|biz)
      template: v.template, planTier: PUBLIC_PLAN[PLAN_BY_CODE[v.plan] ?? 0], customDomain: v.customDomain,
      country: v.country, currency: v.currency,
      deliveryFee: v.deliveryFee, deliveryFreeOver: v.deliveryFreeOver,
      deliveryNote: v.deliveryNote, payMethods: v.payMethods, payNote: v.payNote,
      url: `/${v.slug}`,
    };
  }

  private shape(store: ShopStore, p: ShopProduct, extra: Record<string, unknown> = {}) {
    return {
      id: p.id, name: p.name, summary: p.summary, description: p.description,
      variant: p.variant, price: p.price, oldPrice: p.oldPrice, qty: p.qty,
      image: p.image, categoryId: p.categoryId, brand: p.brand,
      hasVariants: p.hasVariants,
      // §٣.٤: مؤشر توفّر صادق؛ ولا نجوم مصطنعة
      rating: { count: 0, average: 0 },
      stock: p.qty <= 0 ? 'none' : p.qty <= 5 ? 'low' : 'ok',
      stockLabel:
        p.qty <= 0 ? 'نفد المخزون'
        : p.qty <= 5 ? `بقي ${p.qty.toLocaleString('ar-EG')} فقط`
        : 'متوفر',
      wa: waAsk(store, p),
      url: `/${store.slug}?p=${p.id}`,
      ...extra,
    };
  }

  /**
   * بحث وفلترة وترقيم في الخادم — لا نرسل كتالوجًا كاملًا على إنترنت بطيء.
   * عند انتهاء الاشتراك يُخفى ما يتجاوز حدّ الباقة ولا يُحذف (§٥.٥):
   * الأقدم يبقى ظاهرًا فلا يفاجأ العميل باختفاء المتجر كله.
   */
  async products(
    store: ShopStore,
    plan: string,
    q: Record<string, string | undefined>,
  ) {
    const toInt = (v?: string, d = 0) => (Number.isFinite(Number(v)) && v ? Math.trunc(Number(v)) : d);
    const page = Math.max(1, toInt(q.page, 1));
    const per = Math.min(48, Math.max(4, toInt(q.per, 12)));

    const where: Prisma.ShopProductWhereInput = { storeId: store.id, live: true };

    const cap = limitsOf(plan).products;
    if (cap !== null) {
      const visible = await this.prisma.shopProduct.findMany({
        where: { storeId: store.id, live: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: cap,
        select: { id: true },
      });
      where.id = { in: visible.map((v) => v.id) };
    }

    // «تخفيض»: oldPrice أعلى فعلًا من price — مقارنة عمودين لا يعبّر عنها Prisma
    if (q.sale === '1') {
      const sale = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM shop_products
         WHERE store_id = ${store.id}::uuid AND live = true
           AND old_price IS NOT NULL AND old_price > price`;
      const saleIds = new Set(sale.map((r) => r.id));
      const current = (where.id as { in?: string[] } | undefined)?.in;
      where.id = { in: (current ?? [...saleIds]).filter((id) => saleIds.has(id)) };
    }

    if (q.cat) where.categoryId = q.cat;
    const text = (q.q ?? '').trim().slice(0, 60);
    if (text) {
      where.OR = [
        { name: { contains: text, mode: 'insensitive' } },
        { summary: { contains: text, mode: 'insensitive' } },
        { description: { contains: text, mode: 'insensitive' } },
      ];
    }
    if (q.stock === '1') where.qty = { gt: 0 };
    const min = toInt(q.min);
    const max = toInt(q.max);
    if (min || max) where.price = { ...(min ? { gte: min } : {}), ...(max ? { lte: max } : {}) };

    const [total, rows] = await Promise.all([
      this.prisma.shopProduct.count({ where }),
      this.prisma.shopProduct.findMany({
        where,
        orderBy: SORTS[q.sort ?? 'new'] ?? SORTS.new,
        take: per,
        skip: (page - 1) * per,
      }),
    ]);

    const products = rows.map((p) => this.shape(store, p));

    return {
      products,
      total,
      page,
      per,
      pages: Math.max(1, Math.ceil(total / per)),
      hasMore: page * per < total,
    };
  }

  /** بيانات المتجر مع صفحة المنتجات الأولى (§٥.٣). */
  async storefront(slug: string, q: Record<string, string | undefined>) {
    const r = await this.resolve(slug);
    if (r.kind === 'moved') return { moved: r.to };
    const { store, plan } = r;

    const [cats, counts, zones] = await Promise.all([
      this.prisma.shopCategory.findMany({
        where: { storeId: store.id },
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.shopProduct.groupBy({
        by: ['categoryId'],
        where: { storeId: store.id, live: true },
        _count: { _all: true },
      }),
      this.prisma.shopDeliveryZone.findMany({
        where: { storeId: store.id },
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      }),
    ]);
    const byCat = new Map(counts.map((c) => [c.categoryId, c._count._all]));

    return {
      store: this.publicStore(store, plan),
      delivery: {
        // الرسم العام يبقى: متجر لم يُعرّف مناطق يعمل كما كان
        fee: store.deliveryFee,
        freeOver: store.deliveryFreeOver,
        note: store.deliveryNote,
        zones: zones.map((z) => ({ id: z.id, name: z.name, fee: z.fee, freeOver: z.freeOver })),
      },
      payment: {
        methods: store.payMethods
          .split(',')
          .map((m) => m.trim())
          .filter((m): m is keyof typeof PAY_METHODS => m in PAY_METHODS)
          .map((m) => ({ ...PAY_METHODS[m] })),
        note: store.payNote,
      },
      categories: cats.map((c) => ({
        id: c.id, name: c.name, parentId: c.parentId, count: byCat.get(c.id) ?? 0,
      })),
      ...(await this.products(store, plan, q)),
    };
  }

  /** منتج واحد بمعرضه وخياراته — رابط قابل للمشاركة. */
  async product(slug: string, id: string) {
    const { store, plan } = await this.live(slug);
    const p = await this.prisma.shopProduct.findFirst({
      where: { id, storeId: store.id, live: true },
      include: {
        images: { orderBy: { sort: 'asc' } },
        variants: { where: { live: true }, orderBy: { sort: 'asc' } },
      },
    });
    if (!p) throw new NotFoundException('المنتج غير موجود');

    const axis = (key: 'v1' | 'v2', name: string) => {
      const values: string[] = [];
      for (const v of p.variants) if (v[key] && !values.includes(v[key])) values.push(v[key]);
      return values.length ? { key, name, values } : null;
    };

    return {
      store: this.publicStore(store, plan),
      product: this.shape(store, p, {
        images: p.images.map((i) => i.url),
        ...(p.hasVariants
          ? {
              variants: p.variants.map((v) => ({
                id: v.id, v1: v.v1, v2: v.v2,
                label: variantLabel(p, v),
                price: variantPrice(p, v),
                qty: v.qty,
                inStock: v.qty > 0,
              })),
              axes: [axis('v1', p.opt1Name), axis('v2', p.opt2Name)].filter(Boolean),
            }
          : {}),
      }),
    };
  }

  /** معرّفات المنتجات الظاهرة ضمن حدّ الباقة — الأقدم يبقى، والزائد يُخفى لا يُحذف (§٥.٥). */
  private async visibleIds(store: ShopStore, plan: string): Promise<string[] | null> {
    const cap = limitsOf(plan).products;
    if (cap === null) return null;
    const rows = await this.prisma.shopProduct.findMany({
      where: { storeId: store.id, live: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: cap,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * الكتالوج كاملًا في نداء واحد — لصفحة المتجر المصيَّرة على الخادم.
   *
   * قوالب الواجهة (التوقيع، أتولييه، برو) ترشّح وترتّب في المتصفح وتعرض
   * المقاسات والألوان في الشبكة نفسها، فتحتاج كل المنتجات مع محاور
   * خياراتها دفعة واحدة. الترقيم في `products` لمن يبني واجهة مختلفة.
   *
   * العدّادات (تصنيفات، ماركات) تُشتقّ من المنتجات المعروضة نفسها فلا يظهر
   * في مرشّح خيار لا يعطي اختياره نتيجة. والتقييمات صفر حتى تُبنى وحدتها —
   * والواجهة تصمت عند الصفر بدل نجوم مصطنعة.
   */
  async catalogue(slug: string) {
    const r = await this.resolve(slug);
    if (r.kind === 'moved') return { moved: r.to };
    const { store, plan } = r;

    const ids = await this.visibleIds(store, plan);
    const ratings = await this.reviews.summary(store.id);
    const [rows, cats, zones] = await Promise.all([
      this.prisma.shopProduct.findMany({
        where: { storeId: store.id, live: true, ...(ids ? { id: { in: ids } } : {}) },
        orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
        include: {
          variants: { where: { live: true }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] },
        },
      }),
      this.prisma.shopCategory.findMany({
        where: { storeId: store.id },
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true },
      }),
      this.prisma.shopDeliveryZone.findMany({
        where: { storeId: store.id },
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const products = rows.map((p) => {
      // المحاور بترتيب التاجر لا أبجديًا: «كبير» قبل «صغير» يقرؤه العميل مبعثرًا.
      // والقيمة النافدة تبقى مشطوبة: العميل يعرف أن المقاس موجود ونفد.
      const axis = (key: 'v1' | 'v2', name: string) => {
        if (!name || !p.hasVariants) return null;
        const seen = new Map<string, { value: string; inStock: boolean; image: string }>();
        for (const v of p.variants) {
          const value = v[key];
          if (!value) continue;
          const had = seen.get(value);
          if (!had) seen.set(value, { value, inStock: v.qty > 0, image: v.image });
          else {
            if (v.qty > 0) had.inStock = true;
            if (!had.image && v.image) had.image = v.image;
          }
        }
        return seen.size ? { key, name, values: [...seen.values()] } : null;
      };
      return {
        id: p.id,
        name: p.name,
        summary: p.summary,
        description: p.description,
        variant: p.variant,
        price: p.price,
        oldPrice: p.oldPrice,
        qty: p.qty,
        image: p.image,
        categoryId: p.categoryId,
        hasVariants: p.hasVariants,
        stock: p.qty <= 0 ? 'none' : p.qty <= 5 ? 'low' : 'ok',
        stockLabel:
          p.qty <= 0 ? 'نفد المخزون'
          : p.qty <= 5 ? `بقي ${p.qty.toLocaleString('ar-EG')} فقط`
          : 'متوفر',
        brand: p.brand,
        // من تقييمات المشترين المنشورة وحدها — صفر يعني «لم يُقيَّم بعد»
        rating: ratings.get(p.id)?.average ?? 0,
        reviewCount: ratings.get(p.id)?.count ?? 0,
        axes: [axis('v1', p.opt1Name), axis('v2', p.opt2Name)].filter(Boolean),
        // صورة المنتج ليست بديلًا لنفسها — فلا يومض التمرير على الصورة ذاتها
        altImages: [...new Set(p.variants.map((v) => v.image).filter((i) => i && i !== p.image))],
      };
    });

    const catTally = new Map<string, number>();
    const brandTally = new Map<string, number>();
    for (const p of products) {
      if (p.categoryId) catTally.set(p.categoryId, (catTally.get(p.categoryId) ?? 0) + 1);
      if (p.brand) brandTally.set(p.brand, (brandTally.get(p.brand) ?? 0) + 1);
    }

    return {
      store: this.publicStore(store, plan),
      zones: zones.map((z) => ({ id: z.id, name: z.name, fee: z.fee, freeOver: z.freeOver })),
      products,
      categories: cats
        .map((c) => ({ ...c, count: catTally.get(c.id) ?? 0 }))
        .filter((c) => c.count > 0),
      brands: [...brandTally.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar')),
    };
  }

  /** روابط كل المتاجر النشطة — لخريطة الموقع. */
  async sitemap() {
    const rows = await this.prisma.shopStore.findMany({
      where: { status: StoreStatus.Active },
      select: { slug: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    return rows.map((s) => ({ slug: s.slug, updatedAt: s.updatedAt }));
  }

  /** متاجر حقيقية للعرض في الصفحة الرئيسية (§٣.١). */
  async showcase(limit = 6, samples = 0) {
    const take = Math.min(12, Math.max(1, limit));
    const per = Math.min(6, Math.max(0, samples));
    const rows = await this.prisma.shopStore.findMany({
      where: { status: StoreStatus.Active },
      include: { _count: { select: { products: { where: { live: true } } } } },
      take: 60,
    });
    const chosen = rows
      // متجر بلا منتج حيّ لا يُعرض: بطاقة فارغة تقول عكس ما يقوله الشريط
      .filter((s) => s._count.products > 0)
      .sort((a, b) => b._count.products - a._count.products || (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, take);

    // عيّنات المنتجات باستعلام واحد لكل المتاجر لا استعلام لكل متجر؛ والمنتج بلا صورة لا يُعرض
    const bySlug = new Map<string, Array<{ name: string; price: number; image: string }>>();
    if (per && chosen.length) {
      const products = await this.prisma.shopProduct.findMany({
        where: { storeId: { in: chosen.map((s) => s.id) }, live: true, image: { not: '' } },
        orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
        select: { storeId: true, name: true, price: true, image: true },
        take: chosen.length * 30,
      });
      const slugOf = new Map(chosen.map((s) => [s.id, s.slug]));
      for (const p of products) {
        const slug = slugOf.get(p.storeId)!;
        const got = bySlug.get(slug) ?? [];
        if (got.length < per) got.push({ name: p.name, price: p.price, image: p.image });
        bySlug.set(slug, got);
      }
    }

    return chosen.map((s) => ({
      slug: s.slug, name: s.name, sector: s.sector, logo: s.logo, banner: s.banner,
      color: s.color, colorDeep: s.colorDeep, verified: s.verified, city: s.city, country: s.country,
      products: s._count.products, currency: symbolOf(s.country), url: `/${s.slug}`,
      ...(per ? { samples: bySlug.get(s.slug) ?? [] } : {}),
    }));
  }
}
