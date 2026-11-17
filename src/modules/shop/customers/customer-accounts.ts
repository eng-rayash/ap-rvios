import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Ip,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, ShopStore } from '@prisma/client';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, NotEquals } from 'class-validator';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { ShopSection } from '../../../common/tenant/shop-sections';
import { Public, RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { ShopPublicService } from '../public/public.service';
import { PublicRateLimit } from '../public/rate-limit';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { ORDER_LABEL, OrderStatus, toE164 } from '../shop.constants';

type Tx = Prisma.TransactionClient;
type Db = Pick<Tx, 'shopNotice' | 'shopWalletTx'>;
const MIN = 60_000;

// ═══════════════════════════════════════════════════════════════
// المرسِل — نقطة ربط مزوّد الرسائل
// ═══════════════════════════════════════════════════════════════

/**
 * رسائل العملاء (رمز الدخول والإشعارات) — المزوّد يُربط هنا وحده.
 *
 * `CUSTOMER_MSG_DRIVER`:
 *   • `console` — يطبع الرسالة في سجل الخادم (التطوير والاختبار؛ الافتراضي خارج الإنتاج)
 *   • `none`    — لا مزوّد: حسابات العملاء مخفية في المتاجر (الافتراضي في الإنتاج)
 *   • لاحقًا `whatsapp` / `sms`: تُضاف حالة في `deliver()` بمفاتيح المزوّد من البيئة،
 *     فتعمل الحسابات والإشعارات في كل المتاجر بلا تغيير آخر.
 */
@Injectable()
export class CustomerMessenger {
  private readonly log = new Logger('CustomerMessenger');
  /** آخر رسالة لكل رقم — للاختبارات وحدها */
  readonly outbox = new Map<string, string>();

  driver(): string {
    return process.env.CUSTOMER_MSG_DRIVER || (process.env.NODE_ENV === 'production' ? 'none' : 'console');
  }

  /** هل يستطيع المتجر إرسال رموز الدخول؟ — بدونه تُخفى الحسابات */
  enabled(): boolean {
    return this.driver() !== 'none';
  }

  async send(phone: string, text: string): Promise<boolean> {
    const d = this.driver();
    if (d === 'none') return false;
    if (d === 'console') {
      if (process.env.NODE_ENV === 'test') this.outbox.set(phone, text);
      else this.log.log(`→ +${phone}: ${text}`);
      return true;
    }
    // مكان المزوّد: if (d === 'whatsapp') return this.whatsapp(phone, text) …
    this.log.warn(`مزوّد رسائل غير معروف: ${d}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// الإشعارات
// ═══════════════════════════════════════════════════════════════

export class BroadcastDto {
  @IsString() @Length(2, 80) title!: string;
  @IsString() @Length(2, 500) body!: string;
  /** مسار داخل المتجر: /p/<id> أو /shop … */
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^\/[\w\-/]*$/, { message: 'الرابط مسار داخل المتجر يبدأ بـ /' }) link?: string;
  /** all كل العملاء · buyers من اشترى · returning من اشترى أكثر من مرة · accounts من لهم حساب */
  @IsIn(['all', 'buyers', 'returning', 'accounts']) audience!: 'all' | 'buyers' | 'returning' | 'accounts';
  /** يُرسل أيضًا برسالة جوال حين يُربط المزوّد */
  @IsOptional() @IsBoolean() sms?: boolean;
}

@Injectable()
export class CustomerNotices {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly messenger: CustomerMessenger,
  ) {}

  add(db: Db, n: { companyId: string; storeId: string; customerId: string; kind: string; title: string; body?: string; link?: string }) {
    return db.shopNotice.create({
      data: { companyId: n.companyId, storeId: n.storeId, customerId: n.customerId, kind: n.kind, title: n.title.slice(0, 120), body: (n.body ?? '').slice(0, 600), link: n.link ?? '' },
    });
  }

  /** إشعار تغيّر حالة الطلب — يراه العميل في حسابه */
  async orderStatus(store: ShopStore, o: { id: string; ref: string; customerId: string | null; status: number; cancelReason?: string; carrierName?: string; trackingNo?: string }) {
    if (!o.customerId) return;
    const text: Partial<Record<OrderStatus, [string, string]>> = {
      [OrderStatus.Confirmed]: ['أكّد المتجر طلبك', 'نجهّزه لك الآن.'],
      [OrderStatus.Preparing]: ['طلبك قيد التجهيز', ''],
      [OrderStatus.Shipped]: ['شُحن طلبك', [o.carrierName && `مع ${o.carrierName}`, o.trackingNo && `رقم الشحنة ${o.trackingNo}`].filter(Boolean).join(' — ')],
      [OrderStatus.Done]: ['وصل طلبك', 'شكرًا لتسوّقك معنا.'],
      [OrderStatus.Off]: ['أُلغي طلبك', o.cancelReason ? `السبب: ${o.cancelReason}` : ''],
      [OrderStatus.Returned]: ['أُرجع طلبك', ''],
    };
    const t = text[o.status as OrderStatus];
    if (!t) return;
    await this.add(this.prisma, { companyId: store.companyId, storeId: store.id, customerId: o.customerId, kind: 'order', title: `${t[0]} ${o.ref}`, body: t[1], link: `/order/${o.ref}` }).catch(() => undefined);
  }

  async broadcast(ctx: TenantContext, storeId: string, dto: BroadcastDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const since = new Date(Date.now() - 24 * 60 * MIN);
    if ((await db.shopBroadcast.count({ where: { storeId, createdAt: { gte: since } } })) >= 5) {
      throw new BadRequestException('حدّ الإشعارات الجماعية ٥ في اليوم — حتى لا يمل عملاؤك');
    }
    const where: Prisma.ShopCustomerWhereInput = { storeId };
    if (dto.audience === 'buyers') where.orders = { some: {} };
    if (dto.audience === 'accounts') where.verifiedAt = { not: null };
    let customers = await db.shopCustomer.findMany({ where, select: { id: true, phone: true, _count: { select: { orders: true } } }, take: 5000 });
    if (dto.audience === 'returning') customers = customers.filter((c) => c._count.orders > 1);
    const link = dto.link ?? '';
    await db.shopNotice.createMany({
      data: customers.map((c) => ({ companyId: store.companyId, storeId, customerId: c.id, kind: 'broadcast', title: dto.title.trim(), body: dto.body.trim(), link })),
    });
    let sent = 0;
    if (dto.sms && this.messenger.enabled()) {
      for (const c of customers) if (await this.messenger.send(c.phone, `${store.name}: ${dto.title.trim()}\n${dto.body.trim()}`)) sent++;
    }
    const b = await db.shopBroadcast.create({
      data: { companyId: store.companyId, storeId, title: dto.title.trim(), body: dto.body.trim(), link, audience: dto.audience, recipients: customers.length, sent },
    });
    return { ...b, smsAvailable: this.messenger.enabled() };
  }

  async broadcasts(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const [list, total, accounts, buyers] = await Promise.all([
      db.shopBroadcast.findMany({ where: { storeId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      db.shopCustomer.count({ where: { storeId } }),
      db.shopCustomer.count({ where: { storeId, verifiedAt: { not: null } } }),
      db.shopCustomer.count({ where: { storeId, orders: { some: {} } } }),
    ]);
    return { broadcasts: list, audience: { all: total, accounts, buyers }, smsAvailable: this.messenger.enabled() };
  }
}

// ═══════════════════════════════════════════════════════════════
// المحفظة
// ═══════════════════════════════════════════════════════════════

export class WalletAdjustDto {
  /** موجب يضيف، سالب يخصم (لا يتجاوز الرصيد) */
  @IsInt() @NotEquals(0) @Min(-100_000_000) @Max(100_000_000) amount!: number;
  @IsOptional() @IsString() @MaxLength(120) note?: string;
}

/**
 * محفظة العميل — رصيد بعملة المتجر يضيفه التاجر (تعويض، استرداد مرتجع) ويدفع منه العميل
 * في طلبه القادم وهو مسجّل الدخول. الدفع من المحفظة دفعٌ لا خصم: إجمالي الطلب كما هو.
 */
@Injectable()
export class CustomerWallet {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly notices: CustomerNotices,
  ) {}

  async credit(tx: Tx, c: { companyId: string; storeId: string; customerId: string }, amount: number, kind: string, note: string, orderId?: string) {
    if (amount <= 0) return;
    await tx.shopCustomer.update({ where: { id: c.customerId }, data: { wallet: { increment: amount } } });
    await tx.shopWalletTx.create({ data: { ...c, orderId: orderId ?? null, amount, kind, note } });
  }

  /** خصم ذرّي شرطي — لا يُصرف أكثر من الرصيد مهما تزامنت الطلبات */
  async debit(tx: Tx, c: { companyId: string; storeId: string; customerId: string }, amount: number, kind: string, note: string, orderId?: string) {
    if (amount <= 0) return;
    const r = await tx.shopCustomer.updateMany({ where: { id: c.customerId, storeId: c.storeId, wallet: { gte: amount } }, data: { wallet: { decrement: amount } } });
    if (!r.count) throw new BadRequestException('رصيد المحفظة لا يكفي');
    await tx.shopWalletTx.create({ data: { ...c, orderId: orderId ?? null, amount: -amount, kind, note } });
  }

  history(db: Db, customerId: string) {
    return db.shopWalletTx.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async merchantView(ctx: TenantContext, storeId: string, customerId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const c = await db.shopCustomer.findFirst({ where: { id: customerId, storeId }, select: { id: true, name: true, phone: true, wallet: true } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    return { customer: c, history: await db.shopWalletTx.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 100 }) };
  }

  async adjust(ctx: TenantContext, storeId: string, customerId: string, dto: WalletAdjustDto) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const c = await this.prisma.forTenant(ctx.companyId).shopCustomer.findFirst({ where: { id: customerId, storeId } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    const note = (dto.note ?? '').trim();
    const ref = { companyId: c.companyId, storeId, customerId };
    const balance = await this.prisma.$transaction(async (tx) => {
      if (dto.amount > 0) await this.credit(tx, ref, dto.amount, 'credit', note);
      else await this.debit(tx, ref, -dto.amount, 'debit', note);
      return (await tx.shopCustomer.findUnique({ where: { id: c.id }, select: { wallet: true } }))!.wallet;
    });
    if (dto.amount > 0) {
      await this.notices.add(this.prisma, { companyId: c.companyId, storeId, customerId, kind: 'wallet', title: `أُضيف ${dto.amount.toLocaleString('en-US')} لمحفظتك في ${store.name}`, body: note, link: '/account' }).catch(() => undefined);
    }
    return { wallet: balance };
  }
}

// ═══════════════════════════════════════════════════════════════
// الدخول برمز الجوال
// ═══════════════════════════════════════════════════════════════

export class OtpRequestDto {
  @IsString() @Length(6, 20) phone!: string;
}
export class OtpVerifyDto {
  @IsString() @Length(6, 20) phone!: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'الرمز ستة أرقام' }) code!: string;
}
export class AccountUpdateDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
}

const hashCode = (storeId: string, phone: string, code: string) =>
  createHash('sha256').update(`${storeId}|${phone}|${code}|${process.env.JWT_SECRET ?? ''}`).digest('hex');

export type CustomerClaims = { sub: string; sid: string; typ: 'shop_customer' };

@Injectable()
export class CustomerAuth {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly messenger: CustomerMessenger,
  ) {}

  /** مفتاح توقيع مستقل عن جلسات التجّار — رمز العميل لا يصلح رمزَ تاجر أبدًا */
  private secret() {
    return `${this.config.get<string>('JWT_SECRET')}::shop-customer`;
  }

  phoneOf(store: ShopStore, input: string) {
    const p = toE164(input, store.country);
    if (!p) throw new BadRequestException('رقم جوال غير صالح');
    return p;
  }

  async requestOtp(store: ShopStore, input: string) {
    if (!this.messenger.enabled()) throw new BadRequestException('الدخول برمز الجوال غير متاح في هذا المتجر بعد');
    const phone = this.phoneOf(store, input);
    const recent = await this.prisma.shopCustomerOtp.count({ where: { storeId: store.id, phone, createdAt: { gte: new Date(Date.now() - 60 * MIN) } } });
    if (recent >= 5) throw new BadRequestException('طلبت رموزًا كثيرة — حاول بعد ساعة');
    const last = await this.prisma.shopCustomerOtp.findFirst({ where: { storeId: store.id, phone }, orderBy: { createdAt: 'desc' } });
    if (last && Date.now() - last.createdAt.getTime() < MIN) throw new BadRequestException('انتظر دقيقة قبل طلب رمز جديد');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.shopCustomerOtp.create({ data: { storeId: store.id, phone, codeHash: hashCode(store.id, phone, code), expiresAt: new Date(Date.now() + 10 * MIN) } });
    await this.messenger.send(phone, `رمز دخولك إلى ${store.name}: ${code}\nصالح ١٠ دقائق. لا تشاركه مع أحد.`);
    // الرموز القديمة لا تبقى
    if (Math.random() < 0.05) await this.prisma.shopCustomerOtp.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * MIN) } } });
    return { ok: true, phone, expiresIn: 600 };
  }

  async verify(store: ShopStore, input: string, code: string) {
    const phone = this.phoneOf(store, input);
    const otp = await this.prisma.shopCustomerOtp.findFirst({ where: { storeId: store.id, phone, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!otp || otp.attempts >= 5) throw new UnauthorizedException('الرمز منتهٍ — اطلب رمزًا جديدًا');
    const ok = timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(hashCode(store.id, phone, code)));
    if (!ok) {
      await this.prisma.shopCustomerOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('الرمز غير صحيح');
    }
    await this.prisma.shopCustomerOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    const customer = await this.prisma.shopCustomer.upsert({
      where: { storeId_phone: { storeId: store.id, phone } },
      create: { companyId: store.companyId, storeId: store.id, phone, verifiedAt: new Date() },
      update: { verifiedAt: new Date() },
    });
    const claims: CustomerClaims = { sub: customer.id, sid: store.id, typ: 'shop_customer' };
    const token = await this.jwt.signAsync(claims, { secret: this.secret(), expiresIn: '30d' });
    return { token, customer: { id: customer.id, name: customer.name, phone: customer.phone } };
  }

  /** العميل من ترويسة `X-Customer-Token` — لمتجر بعينه وإلا رُفض */
  async resolve(store: ShopStore, token?: string) {
    if (!token) throw new UnauthorizedException('سجّل الدخول أولًا');
    let claims: CustomerClaims;
    try {
      claims = await this.jwt.verifyAsync<CustomerClaims>(token, { secret: this.secret() });
    } catch {
      throw new UnauthorizedException('انتهت جلستك — سجّل الدخول من جديد');
    }
    if (claims.typ !== 'shop_customer' || claims.sid !== store.id) throw new UnauthorizedException('جلسة لمتجر آخر');
    const c = await this.prisma.shopCustomer.findFirst({ where: { id: claims.sub, storeId: store.id } });
    if (!c || !c.verifiedAt) throw new UnauthorizedException('انتهت جلستك — سجّل الدخول من جديد');
    return c;
  }
}

// ═══════════════════════════════════════════════════════════════
// المسارات
// ═══════════════════════════════════════════════════════════════

/** حساب العميل في واجهة المتجر — الهوية من رمز الجوال، والجلسة في `X-Customer-Token` */
@Public()
@Controller('shop/storefront/:slug/account')
export class CustomerAccountController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly publicShop: ShopPublicService,
    private readonly auth: CustomerAuth,
    private readonly wallet: CustomerWallet,
    private readonly limit: PublicRateLimit,
  ) {}

  @Post('otp')
  async otp(@Param('slug') slug: string, @Body() dto: OtpRequestDto, @Ip() ip: string) {
    const { store } = await this.publicShop.live(slug);
    await this.publicShop.assertNotDemo(store);
    this.limit.check(`otp:${ip}`, 10, 60 * MIN);
    return this.auth.requestOtp(store, dto.phone);
  }

  @Post('verify')
  async verify(@Param('slug') slug: string, @Body() dto: OtpVerifyDto, @Ip() ip: string) {
    const { store } = await this.publicShop.live(slug);
    this.limit.check(`otp-verify:${ip}`, 20, 15 * MIN);
    return this.auth.verify(store, dto.phone, dto.code);
  }

  @Get()
  async me(@Param('slug') slug: string, @Headers('x-customer-token') token?: string) {
    const { store } = await this.publicShop.live(slug);
    const c = await this.auth.resolve(store, token);
    const unread = await this.prisma.shopNotice.count({ where: { customerId: c.id, readAt: null } });
    return {
      customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, wallet: c.wallet, points: c.points },
      loyaltyRate: store.loyaltyRate,
      unread,
    };
  }

  @Patch()
  async update(@Param('slug') slug: string, @Body() dto: AccountUpdateDto, @Headers('x-customer-token') token?: string) {
    const { store } = await this.publicShop.live(slug);
    const c = await this.auth.resolve(store, token);
    const u = await this.prisma.shopCustomer.update({
      where: { id: c.id },
      data: { ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.address !== undefined && { address: dto.address.trim() }) },
    });
    return { id: u.id, name: u.name, phone: u.phone, address: u.address };
  }

  @Get('orders')
  async orders(@Param('slug') slug: string, @Headers('x-customer-token') token?: string) {
    const { store } = await this.publicShop.live(slug);
    const c = await this.auth.resolve(store, token);
    const rows = await this.prisma.shopOrder.findMany({
      where: { storeId: store.id, customerId: c.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { ref: true, status: true, total: true, walletPaid: true, createdAt: true, _count: { select: { items: true } }, items: { select: { name: true }, take: 2 } },
    });
    return { orders: rows.map((o) => ({ ...o, statusLabel: ORDER_LABEL[o.status as OrderStatus] })) };
  }

  @Get('wallet')
  async walletView(@Param('slug') slug: string, @Headers('x-customer-token') token?: string) {
    const { store } = await this.publicShop.live(slug);
    const c = await this.auth.resolve(store, token);
    const points = await this.prisma.shopPointsTx.findMany({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { wallet: c.wallet, points: c.points, history: await this.wallet.history(this.prisma, c.id), pointsHistory: points };
  }

  @Get('notices')
  async notices(@Param('slug') slug: string, @Headers('x-customer-token') token?: string) {
    const { store } = await this.publicShop.live(slug);
    const c = await this.auth.resolve(store, token);
    return { notices: await this.prisma.shopNotice.findMany({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 50 }) };
  }

  @Post('notices/read')
  async read(@Param('slug') slug: string, @Headers('x-customer-token') token?: string) {
    const { store } = await this.publicShop.live(slug);
    const c = await this.auth.resolve(store, token);
    await this.prisma.shopNotice.updateMany({ where: { customerId: c.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }
}

/** محفظة العميل والإشعارات الجماعية — لوحة التاجر */
@Controller('shop/stores/:storeId')
export class CustomerWalletController {
  constructor(
    private readonly wallet: CustomerWallet,
    private readonly notices: CustomerNotices,
  ) {}

  @ShopSection('customers')
  @Get('customers/:customerId/wallet')
  view(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.wallet.merchantView(ctx, storeId, customerId);
  }

  @RequireRole(UserRole.DeptManager)
  @ShopSection('customers')
  @Post('customers/:customerId/wallet')
  adjust(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('customerId', ParseUUIDPipe) customerId: string, @Body() dto: WalletAdjustDto) {
    return this.wallet.adjust(ctx, storeId, customerId, dto);
  }

  @ShopSection('marketing')
  @Get('broadcasts')
  broadcasts(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Query('_') _?: string) {
    return this.notices.broadcasts(ctx, storeId);
  }

  @RequireRole(UserRole.DeptManager)
  @ShopSection('marketing')
  @Post('broadcasts')
  broadcast(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: BroadcastDto) {
    return this.notices.broadcast(ctx, storeId, dto);
  }
}
