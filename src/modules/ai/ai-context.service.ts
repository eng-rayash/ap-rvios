import { Injectable } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { AnalyticsService } from '../shop/analytics/analytics.service';
import { StoreAccess } from '../shop/shop-store-access.service';
import { ORDER_LABEL, OrderStatus, PLAN_NAME, countryOf } from '../shop/shop.constants';
import { dataText } from './ai.sanitize';

const PAY: Record<string, string> = { cod: 'عند الاستلام', bank: 'تحويل بنكي', wallet: 'محفظة' };

/**
 * بيانات المتجر التي يراها المساعد — من الخدمات القائمة نفسها التي تعرض اللوحة،
 * فلا رقم يختلف عمّا يراه التاجر في «التحليلات».
 *
 * مجاميع فقط: لا أسماء عملاء ولا جوالاتهم ولا عناوينهم — لا يحتاجها التحليل،
 * ولا تُرسل إلى مزوّد خارجي.
 */
@Injectable()
export class AiContextService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async build(ctx: TenantContext, access: StoreAccess, insights: boolean): Promise<string> {
    const { store, plan } = access;
    const db = this.prisma.forTenant(ctx.companyId);
    const [products, categories, total, live, noDesc, noImage, outOfStock] = await Promise.all([
      db.shopProduct.findMany({
        where: { storeId: store.id },
        orderBy: [{ live: 'desc' }, { sort: 'asc' }, { createdAt: 'desc' }],
        take: 30,
        select: { name: true, price: true, oldPrice: true, qty: true, live: true, hasVariants: true, category: { select: { name: true } } },
      }),
      db.shopCategory.findMany({ where: { storeId: store.id }, select: { name: true }, take: 30 }),
      db.shopProduct.count({ where: { storeId: store.id } }),
      db.shopProduct.count({ where: { storeId: store.id, live: true } }),
      db.shopProduct.count({ where: { storeId: store.id, description: '' } }),
      db.shopProduct.count({ where: { storeId: store.id, image: '' } }),
      db.shopProduct.count({ where: { storeId: store.id, live: true, qty: { lte: 0 }, hasVariants: false } }),
    ]);

    const country = countryOf(store.country);
    const cur = country.symbol;
    const lines: string[] = [
      `# المتجر`,
      `الاسم: ${dataText(store.name, 80)} · الرابط: ${store.slug} · الدولة: ${country.name} · العملة: ${cur} (${country.currency}) · القالب: ${store.template} · الباقة: ${PLAN_NAME[plan] ?? plan}`,
      `# الكتالوج (الآن)`,
      `المنتجات: ${total} (منشور ${live}) · بلا وصف: ${noDesc} · بلا صورة: ${noImage} · نافدة المخزون: ${outOfStock}`,
      `التصنيفات: ${categories.length ? categories.map((c) => dataText(c.name, 40)).join('، ') : 'لا تصنيفات'}`,
    ];
    if (products.length) {
      lines.push(`أول ${products.length} منتج (الاسم | السعر | المخزون | التصنيف):`);
      for (const p of products) {
        const price = p.oldPrice && p.oldPrice > p.price ? `${p.price} (قبل الخصم ${p.oldPrice})` : `${p.price}`;
        lines.push(`- ${dataText(p.name, 70)} | ${price} ${cur} | ${p.hasVariants ? 'بخيارات' : p.qty} | ${dataText(p.category?.name ?? '—', 30)}${p.live ? '' : ' | مخفي'}`);
      }
    }

    if (insights) lines.push(...(await this.performance(ctx, store.id, cur)));
    return lines.join('\n');
  }

  /** آخر ٣٠ يومًا مفصّلة، ومقارنتها بالثلاثين التي قبلها من السلسلة اليومية نفسها */
  private async performance(ctx: TenantContext, storeId: string, cur: string): Promise<string[]> {
    const [r30, r60] = await Promise.all([
      this.analytics.analytics(ctx, storeId, 30),
      this.analytics.analytics(ctx, storeId, 60),
    ]);
    const prev = r60.series.slice(0, r60.series.length - 30);
    const sum = (k: 'orders' | 'revenue' | 'visits') => prev.reduce((a, s) => a + s[k], 0);
    const t = r30.totals;
    const lines = [
      `# الأداء: آخر ٣٠ يومًا (${r30.range.from} إلى ${r30.range.to}) — أرقام فعلية من قاعدة المتجر`,
      `الطلبات: ${t.orders} (مؤكدة/مكتملة ${t.soldOrders}) · المبيعات المؤكدة: ${t.revenue} ${cur} · متوسط الطلب: ${t.averageOrder} ${cur}`,
      `الزيارات الفريدة: ${t.visits} · التحويل (طلبات/زيارات): ${t.conversion}% · الإلغاء: ${t.cancelRate}%`,
      `حسب الحالة: ${Object.entries(r30.byStatus).map(([s, n]) => `${ORDER_LABEL[Number(s) as OrderStatus] ?? s} ${n}`).join('، ')}`,
      `العملاء: مشترون ${r30.customers.buyers} · عائدون ${r30.customers.returning} · جدد ${r30.customers.newBuyers}`,
      `الثلاثون يومًا السابقة (${r60.range.from} وما بعده): طلبات ${sum('orders')} · مبيعات ${sum('revenue')} ${cur} · زيارات ${sum('visits')}`,
    ];
    const pay = Object.entries(r30.byPayMethod);
    if (pay.length) lines.push(`طرق الدفع: ${pay.map(([m, v]) => `${PAY[m] ?? dataText(m, 20)} ${v.orders} طلب/${v.revenue} ${cur}`).join('، ')}`);
    const zones = Object.entries(r30.byZone).sort((a, b) => b[1].orders - a[1].orders).slice(0, 8);
    if (zones.length) lines.push(`المناطق: ${zones.map(([z, v]) => `${dataText(z, 30)} ${v.orders}`).join('، ')}`);
    if (r30.topProducts.length) {
      lines.push(`الأكثر مبيعًا (مؤكدة/مكتملة):`);
      for (const p of r30.topProducts) lines.push(`- ${dataText(p.name, 70)}: ${p.qty} قطعة · ${p.revenue} ${cur}`);
    } else lines.push('الأكثر مبيعًا: لا مبيعات مؤكدة في الفترة');
    const busiest = [...r30.series].sort((a, b) => b.orders - a.orders).filter((d) => d.orders > 0).slice(0, 3);
    if (busiest.length) lines.push(`أنشط الأيام: ${busiest.map((d) => `${d.day} (${d.orders} طلب)`).join('، ')}`);
    if (r30.lowStock.length) lines.push(`مخزون منخفض: ${r30.lowStock.slice(0, 10).map((p) => `${dataText(p.name, 50)} (${p.qty})`).join('، ')}`);
    return lines;
  }
}
