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
import { VisitDto } from '../analytics/visitor-stats';
import { OrdersService } from '../orders/orders.service';
import { PublicRateLimit } from './rate-limit';
import { ShopPublicService } from './public.service';
import { StoresService } from '../stores/stores.service';
import { ShopReviewsService } from '../reviews/reviews.service';
import { SubmitReviewDto } from '../reviews/reviews.dto';
import { CheckCouponDto } from '../coupons/coupons.dto';
import { AskQuestionDto } from '../questions/questions.dto';
import { RequestReturnDto } from '../returns/returns.dto';
import { SaveCartDto, ShopCartsService } from '../carts/carts';
import { CustomerAuth } from '../customers/customer-accounts';
import { isWholesale, stripPrices } from './wholesale';
import { ShopReturnsService } from '../returns/returns.service';
import { ShopQuestionsService } from '../questions/questions.service';
import { CouponsService } from '../coupons/coupons.service';
import { hasFeature } from '../../shop-billing/plans';

/** وضع الجملة فعّال: الميزة في الباقة والتاجر شغّله */
const wholesaleOn = (store: { wholesale: boolean }, plan: string) => store.wholesale && hasFeature(plan, 'wholesale');

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
    private readonly coupons: CouponsService,
    private readonly questions: ShopQuestionsService,
    private readonly returns: ShopReturnsService,
    private readonly carts: ShopCartsService,
    private readonly customerAuth: CustomerAuth,
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
  async storefront(@Param('slug') slug: string, @Query() q: Record<string, string>) {
    const r = await this.publicShop.storefront(slug, q);
    return isWholesale(r) ? stripPrices(r) : r;
  }

  /** الكتالوج كاملًا لصفحة المتجر المصيَّرة على الخادم. */
  @Get(':slug/catalogue')
  async catalogue(@Param('slug') slug: string) {
    const r = await this.publicShop.catalogue(slug);
    return isWholesale(r) ? stripPrices(r) : r;
  }

  @Get(':slug/products')
  async products(@Param('slug') slug: string, @Query() q: Record<string, string>) {
    const { store, plan } = await this.publicShop.live(slug);
    const r = await this.publicShop.products(store, plan, q);
    return wholesaleOn(store, plan) ? stripPrices(r) : r;
  }

  /** تقييمات منتج المنشورة — مع المتوسّط والعدد */
  @Get(':slug/products/:id/reviews')
  async productReviews(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string) {
    const { store } = await this.publicShop.live(slug);
    return this.reviews.published(store, id);
  }

  /** «يُشترى معًا غالبًا» من الطلبات الحقيقية — معرّفات فقط */
  @Get(':slug/products/:id/together')
  together(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.publicShop.together(slug, id);
  }

  /** الأسئلة المُجابة المنشورة — قبل `:id` العام كي لا يلتقطها */
  @Get(':slug/products/:id/questions')
  async productQuestions(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string) {
    const { store } = await this.publicShop.live(slug);
    return { questions: await this.questions.published(store, id) };
  }

  /** سؤال زائر — بلا حساب، بحدّ معدّل، ولا يُنشر قبل إجابة التاجر */
  @Post(':slug/products/:id/questions')
  async ask(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AskQuestionDto, @Ip() ip: string) {
    const { store } = await this.publicShop.live(slug);
    await this.publicShop.assertNotDemo(store);
    this.limit.check(`question:${ip}:${store.id}`, 5, 60 * 60_000);
    return this.questions.ask(store, id, dto);
  }

  @Get(':slug/products/:id')
  async product(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.publicShop.product(slug, id);
    const { store, plan } = await this.publicShop.live(slug);
    return wholesaleOn(store, plan) ? stripPrices(r) : r;
  }

  /** زيارة فريدة يوميًا — بصمة مجزّأة بلا بيانات تعريفية (§١٠). */
  @Post(':slug/visit')
  async visit(
    @Param('slug') slug: string,
    @Ip() ip: string,
    @Headers('user-agent') ua = '',
    @Body() dto: VisitDto = {},
  ) {
    const { store } = await this.publicShop.live(slug);
    this.limit.check(`visit:${ip}:${store.id}`, 300, 10 * 60_000);
    return this.analytics.recordVisit(store, ip, ua, { path: dto?.path, ref: dto?.ref });
  }

  /** حفظ السلة حين يكتب العميل جواله في صفحة الإتمام — لتذكيره إن لم يُكمل (بإشعار في الصفحة) */
  @Post(':slug/carts')
  async saveCart(@Param('slug') slug: string, @Body() dto: SaveCartDto, @Ip() ip: string) {
    const { store, plan } = await this.publicShop.live(slug);
    await this.publicShop.assertNotDemo(store);
    this.limit.check(`cart:${ip}:${store.id}`, 30, 10 * 60_000);
    // الباقة بلا السلات المتروكة: لا يُحفظ شيء (والمتجر لا يعرف الفرق)
    if (!hasFeature(plan, 'abandonedCarts')) return { ok: true };
    return this.carts.save(store, dto);
  }

  /** الطلب يُسجَّل هنا **قبل** أن يفتح العميل واتساب (§٤.١). */
  @Post(':slug/orders')
  async order(
    @Param('slug') slug: string,
    @Body() dto: PlaceOrderDto,
    @Ip() ip: string,
    @Headers('x-customer-token') customerToken?: string,
  ) {
    const { store, plan } = await this.publicShop.live(slug);
    await this.publicShop.assertNotDemo(store);
    if (!hasFeature(plan, 'onlinePayments')) dto.payMethod = 'cod';
    // ١٠ طلبات كل ١٠ دقائق من عنوان واحد لكل متجر — يكفي عميلًا حقيقيًا ويقطع
    // سيلًا آليًا. قابل للضبط للاختبارات ولمتاجر خلف بوّابة مشتركة.
    this.limit.check(`order:${ip}:${store.id}`, Number(process.env.SHOP_ORDER_LIMIT) || 10, 10 * 60_000);

    // العميل المسجّل: الطلب برقم حسابه، وله الدفع من محفظته ومكافآته
    let spend: { customerId: string } | undefined;
    if (customerToken) {
      const c = await this.customerAuth.resolve(store, customerToken);
      dto.phone = c.phone;
      spend = { customerId: c.id };
    }
    // وضع الجملة: الطلب «طلب تسعير» بلا دفع إلكتروني ولا مبالغ في الرد
    const quote = wholesaleOn(store, plan);
    if (quote) { dto.payMethod = 'cod'; dto.walletUsed = 0; dto.pointsUsed = 0; dto.coupon = undefined; }
    const r = await this.orders.place(store, dto, spend, quote ? 'quote' : undefined);
    if (quote) return { ok: true, quote: true, ref: r.order.ref, wa: r.wa, message: `وصل طلب التسعير برقم ${r.order.ref} — يتواصل معك المتجر بالأسعار` };
    return {
      ok: true,
      ref: r.order.ref,
      subtotal: r.subtotal,
      delivery: r.delivery,
      discount: r.discount,
      coupon: r.coupon,
      total: r.total,
      zone: r.zone,
      payMethod: r.payMethod,
      payStatus: r.payStatus,
      walletPaid: r.walletPaid,
      // تعليمات التحويل تُرسل مع الرد: العميل في لحظة الدفع الآن
      payNote: r.payMethod === 'cod' ? '' : store.payNote,
      wa: r.wa,
      message: `سُجّل طلبك برقم ${r.order.ref}`,
    };
  }

  /**
   * معاينة رمز الخصم في السلة — لا يحجز شيئًا، والطلب يعيد التحقق والحساب.
   * حدّ معدّل كي لا يُخمَّن الرمز بالتجربة.
   */
  @Post(':slug/coupons/check')
  async couponCheck(@Param('slug') slug: string, @Body() dto: CheckCouponDto, @Ip() ip: string) {
    const { store } = await this.publicShop.live(slug);
    this.limit.check(`coupon:${ip}:${store.id}`, 20, 10 * 60_000);
    return this.coupons.check(store, dto.code, dto.subtotal ?? 0, dto.delivery ?? 0);
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
    await this.publicShop.assertNotDemo(store);
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
    const { id: orderId, ...pub } = t;
    const out = { ...pub, items: t.items.map((i) => ({ ...i, reviewed: done.has(i.id) })), return: await this.returns.forTracking(store.id, orderId) };
    // طلب تسعير: لا مبالغ للعميل — المتجر يتواصل معه بالسعر
    return t.source === 'quote' ? stripPrices(out) : out;
  }

  /** طلب استرجاع لطلب مكتمل — الإثبات رقم الطلب، بحدّ معدّل */
  @Post(':slug/orders/:ref/return')
  async requestReturn(@Param('slug') slug: string, @Param('ref') ref: string, @Body() dto: RequestReturnDto, @Ip() ip: string) {
    const { store } = await this.publicShop.live(slug);
    await this.publicShop.assertNotDemo(store);
    this.limit.check(`return:${ip}:${store.id}`, 5, 60 * 60_000);
    return this.returns.request(store, ref, dto);
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
    await this.publicShop.assertNotDemo(store);
    this.limit.check(`review:${ip}:${store.id}`, 20, 60 * 60_000);
    return this.reviews.submit(store, ref, dto);
  }
}
