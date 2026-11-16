import { Injectable } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { ShopStoreAccessService } from '../shop-store-access.service';

type Appearance = {
  social?: Record<string, string>;
  extras?: {
    policies?: Record<string, string>;
    tracking?: Record<string, string>;
    seoTitle?: string;
    seoDescription?: string;
  };
} | null;

export interface ReadinessTask {
  key: string;
  title: string;
  hint: string;
  done: boolean;
  /** صفحة اللوحة التي تُنجز منها المهمة — التطبيق يربط المفتاح بشاشته */
  link: string;
}

/**
 * «جاهزية المتجر»: قائمة مهام تُحسب من بيانات المتجر الفعلية لا من علامات يضعها التاجر —
 * المهمة تنجز نفسها حين يُنجز ما تطلبه. الترتيب ترتيب الأولوية: ما يمنع البيع أولًا.
 */
@Injectable()
export class StoreReadinessService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
  ) {}

  async readiness(ctx: TenantContext, storeId: string) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const [products, withImage, categories, zones, coupons, orders] = await Promise.all([
      db.shopProduct.count({ where: { storeId, live: true } }),
      db.shopProduct.count({ where: { storeId, live: true, NOT: { image: '' } } }),
      db.shopCategory.count({ where: { storeId } }),
      db.shopDeliveryZone.count({ where: { storeId } }),
      db.shopCoupon.count({ where: { storeId } }),
      db.shopOrder.count({ where: { storeId } }),
    ]);
    const look = store.appearance as Appearance;
    const ex = look?.extras ?? {};
    const filled = (o?: Record<string, string>) => Object.entries(o ?? {}).filter(([k, v]) => k !== 'placement' && typeof v === 'string' && v.trim()).length;
    const methods = store.payMethods.split(',').map((m) => m.trim()).filter(Boolean);

    const tasks: ReadinessTask[] = [
      { key: 'products', title: 'أضف ٣ منتجات على الأقل', hint: 'متجر بمنتج واحد لا يقنع الزائر — ابدأ بأكثر ما يُطلب منك.', done: products >= 3, link: '/products/new' },
      { key: 'images', title: 'صوّر منتجاتك', hint: 'كل منتج بصورة واضحة — المنتج بلا صورة نادرًا ما يُشترى.', done: products > 0 && withImage === products, link: '/products' },
      { key: 'logo', title: 'ارفع شعار متجرك', hint: 'يظهر في رأس المتجر وفي رابطه حين تشاركه.', done: !!store.logo, link: '/store/appearance' },
      { key: 'about', title: 'عرّف بمتجرك', hint: 'جملة تعريفية ونبذة قصيرة: من أنتم وماذا تبيعون.', done: !!(store.tagline.trim() || store.about.trim()), link: '/store/settings' },
      { key: 'delivery', title: 'حدّد التوصيل', hint: 'مناطق ورسوم التوصيل، أو ملاحظة توضّح كيف توصلون.', done: zones > 0 || store.deliveryFee > 0 || !!store.deliveryNote.trim(), link: '/shipping' },
      { key: 'payment', title: 'فعّل طريقة دفع إلكترونية', hint: 'الكريمي أو جيب أو جوالي إلى جانب الدفع عند الاستلام.', done: methods.some((m) => m !== 'cod'), link: '/store/settings' },
      { key: 'categories', title: 'رتّب منتجاتك في تصنيفات', hint: 'يجد العميل ما يريد أسرع.', done: categories > 0, link: '/categories' },
      { key: 'contact', title: 'أكمل بيانات التواصل', hint: 'العنوان وساعات العمل — تبني الثقة قبل الطلب.', done: !!(store.address.trim() || store.city.trim()) && !!store.hours.trim(), link: '/store/settings' },
      { key: 'policies', title: 'اكتب سياستي التوصيل والاسترجاع', hint: 'أول ما يبحث عنه العميل المتردد.', done: !!ex.policies?.shipping?.trim() && !!ex.policies?.returns?.trim(), link: '/store/appearance' },
      { key: 'social', title: 'اربط حسابات التواصل', hint: 'انستغرام وتيك توك وغيرهما في متجرك.', done: filled(look?.social) > 0, link: '/store/appearance' },
      { key: 'seo', title: 'جهّز ظهورك في Google', hint: 'عنوان ووصف لنتائج البحث.', done: !!(ex.seoTitle?.trim() || ex.seoDescription?.trim()), link: '/store/appearance' },
      { key: 'coupon', title: 'أنشئ أول قسيمة خصم', hint: 'رمز مثل WELCOME10 يشجّع الطلب الأول.', done: coupons > 0, link: '/discounts' },
      { key: 'tracking', title: 'اربط بكسل إعلاناتك', hint: 'Meta أو TikTok أو Snap لتقيس إعلاناتك.', done: filled(ex.tracking) > 0, link: '/store/appearance' },
      { key: 'firstOrder', title: 'استقبل أول طلب', hint: 'شارك رابط متجرك في حالتك وحساباتك.', done: orders > 0, link: '/orders' },
    ];
    const done = tasks.filter((t) => t.done).length;
    return {
      percent: Math.round((done / tasks.length) * 100),
      done,
      total: tasks.length,
      // أول مهمة ناقصة — اقتراح «التالي» في البطاقة
      next: tasks.find((t) => !t.done)?.key ?? null,
      tasks,
    };
  }
}
