import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Public } from '../../../common/tenant/tenant.guard';
import { PlaceOrderDto } from '../orders/orders.dto';
import { MAX_IMAGE_BYTES, UploadsService, type UploadedBinary } from '../../uploads/uploads.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { OrdersService } from '../orders/orders.service';
import { PublicRateLimit } from './rate-limit';
import { ShopPublicService } from './public.service';
import { StoresService } from '../stores/stores.service';
import { ShopReviewsService } from '../reviews/reviews.service';
import { SubmitReviewDto } from '../reviews/reviews.dto';

/**
 * واجهة المتجر العامة — كل المسارات `@Public()` عمدًا: الزائر القادم من رابط
 * مشارَك لا يملك حسابًا. الحماية بحدّ معدّل على الكتابة، وبأن ما يُرجَع قائمة
 * بيضاء لا صفوفًا خامًا.
 */
@Public()
@Controller('shop/storefront')
export class ShopPublicController {
  constructor(
    private readonly publicShop: ShopPublicService,
    private readonly orders: OrdersService,
    private readonly analytics: AnalyticsService,
    private readonly limit: PublicRateLimit,
    private readonly uploads: UploadsService,
    private readonly stores: StoresService,
    private readonly reviews: ShopReviewsService,
  ) {}

  /** متاجر حقيقية للصفحة الرئيسية — قبل `:slug` كي لا يُلتقط اسمًا لمتجر. */
  @Get('showcase/list')
  showcase(@Query('limit') limit?: string, @Query('samples') samples?: string) {
    return this.publicShop.showcase(Number(limit) || 6, Number(samples) || 0);
  }

  /**
   * هل الرابط متاح؟ — عام لخطوة «بيانات المتجر» في منصة المتاجر قبل إنشاء
   * الحساب. يعيد ما يعيده فحص لوحة التاجر نفسه (السبب والاقتراح). قبل `:slug`.
   */
  @Get('slug/check')
  slugCheck(@Query('q') q = '', @Ip() ip: string) {
    this.limit.check(`slug:${ip}`, 120, 60_000);
    if (!q.trim()) return { slug: '', ok: false, reason: 'اكتب رابط متجرك', suggestion: null };
    return this.stores.checkSlug(q);
  }

  /** نطاق خاص ← رابط المتجر (لـ middleware منصة المتاجر، ويخبّئ الناتج). قبل `:slug`. */
  @Get('domain/resolve')
  resolveDomain(@Query('host') host = '') {
    return this.publicShop.slugForDomain(host);
  }

  /** روابط المتاجر النشطة لخريطة الموقع — قبل `:slug` للسبب نفسه. */
  @Get('sitemap/list')
  sitemap() {
    return this.publicShop.sitemap();
  }

  @Get(':slug')
  storefront(@Param('slug') slug: string, @Query() q: Record<string, string>) {
    return this.publicShop.storefront(slug, q);
  }

  /** الكتالوج كاملًا لصفحة المتجر المصيَّرة على الخادم. */
  @Get(':slug/catalogue')
  catalogue(@Param('slug') slug: string) {
    return this.publicShop.catalogue(slug);
  }

  @Get(':slug/products')
  async products(@Param('slug') slug: string, @Query() q: Record<string, string>) {
    const { store, plan } = await this.publicShop.live(slug);
    return this.publicShop.products(store, plan, q);
  }

  /** تقييمات منتج المنشورة — مع المتوسّط والعدد */
  @Get(':slug/products/:id/reviews')
  async productReviews(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string) {
    const { store } = await this.publicShop.live(slug);
    return this.reviews.published(store, id);
  }

  @Get(':slug/products/:id')
  product(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.publicShop.product(slug, id);
  }

  /** زيارة فريدة يوميًا — بصمة مجزّأة بلا بيانات تعريفية (§١٠). */
  @Post(':slug/visit')
  async visit(
    @Param('slug') slug: string,
    @Ip() ip: string,
    @Headers('user-agent') ua = '',
  ) {
    const { store } = await this.publicShop.live(slug);
    return this.analytics.recordVisit(store, ip, ua);
  }

  /** الطلب يُسجَّل هنا **قبل** أن يفتح العميل واتساب (§٤.١). */
  @Post(':slug/orders')
  async order(
    @Param('slug') slug: string,
    @Body() dto: PlaceOrderDto,
    @Ip() ip: string,
  ) {
    const { store } = await this.publicShop.live(slug);
    // ١٠ طلبات كل ١٠ دقائق من عنوان واحد لكل متجر — يكفي عميلًا حقيقيًا ويقطع
    // سيلًا آليًا. قابل للضبط للاختبارات ولمتاجر خلف بوّابة مشتركة.
    this.limit.check(`order:${ip}:${store.id}`, Number(process.env.SHOP_ORDER_LIMIT) || 10, 10 * 60_000);

    const r = await this.orders.place(store, dto);
    return {
      ok: true,
      ref: r.order.ref,
      subtotal: r.subtotal,
      delivery: r.delivery,
      total: r.total,
      zone: r.zone,
      payMethod: r.payMethod,
      payStatus: r.payStatus,
      // تعليمات التحويل تُرسل مع الرد: العميل في لحظة الدفع الآن
      payNote: r.payMethod === 'cod' ? '' : store.payNote,
      wa: r.wa,
      message: `سُجّل طلبك برقم ${r.order.ref}`,
    };
  }

  /**
   * رفع صورة إيصال التحويل (الحقل `file`) — المنصة لا تتحقق من محتواه،
   * والتأكيد قرار التاجر.
   *
   * الصورة تُرفع هنا لا رابطًا جاهزًا: مسار عام يقبل أي رابط كان سيعرض على
   * التاجر صورة من أي موقع باسم «إيصال». والطلب يُتحقَّق منه **قبل** الرفع،
   * ثم تُحفظ الصورة في مجلد المتجر (`stores/<id>/proofs/`) معاد ترميزها.
   */
  @Post(':slug/orders/:ref/proof')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES * 4, files: 1 } }))
  async proof(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Ip() ip: string,
    @UploadedFile() file?: UploadedBinary,
  ) {
    const { store } = await this.publicShop.live(slug);
    this.limit.check(`proof:${ip}:${store.id}`, 10, 30 * 60_000);
    if (!file) throw new BadRequestException('أرفق صورة الإيصال (الحقل file)');
    await this.orders.proofTarget(store, ref);
    const { url } = await this.uploads.saveImage(store.companyId, file, store.id, 'proofs');
    return this.orders.submitProof(store, ref, url);
  }

  @Get(':slug/orders/:ref')
  async track(@Param('slug') slug: string, @Param('ref') ref: string) {
    const { store } = await this.publicShop.live(slug);
    const t = await this.orders.track(store, ref);
    // أيّ الأسطر قُيّم — صاحب الطلب يقيّم ما بقي بعد اكتماله
    const done = await this.reviews.reviewedByRef(store.id, t.ref);
    return { ...t, items: t.items.map((i) => ({ ...i, reviewed: done.has(i.id) })) };
  }

  /** تقييم سطر من طلب مكتمل — الإثبات رقم الطلب، كالتتبّع والإيصال */
  @Post(':slug/orders/:ref/reviews')
  async review(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: SubmitReviewDto,
    @Ip() ip: string,
  ) {
    const { store } = await this.publicShop.live(slug);
    this.limit.check(`review:${ip}:${store.id}`, 20, 60 * 60_000);
    return this.reviews.submit(store, ref, dto);
  }
}
