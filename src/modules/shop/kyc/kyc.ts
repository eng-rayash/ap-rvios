import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import sharp from 'sharp';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly, RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { PlatformContext, TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { PlatformAlerts } from '../../notify/platform-alerts.service';
import { PushService } from '../../notify/push.service';
import { MAX_IMAGE_BYTES, sniffImage, UploadedBinary } from '../../uploads/uploads.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { StorefrontCache } from '../public/storefront-cache.service';

/** 0 مسودة · 1 قيد المراجعة · 2 موثَّق · 3 مرفوض */
export enum KycStatus {
  Draft = 0,
  Pending = 1,
  Approved = 2,
  Rejected = 3,
}

export const KYC_DOC_KINDS = ['id_front', 'id_back', 'selfie', 'cr'] as const;
type DocKind = (typeof KYC_DOC_KINDS)[number];

/** تُحذف صور الوثائق بعد القرار بهذه المدة — القرار وسجله يبقيان */
export const KYC_KEEP_DAYS = 30;
const DAY = 86_400_000;

export class KycInfoDto {
  /** فرد (هوية) أو منشأة (سجل تجاري) */
  @IsIn(['person', 'business']) kind!: 'person' | 'business';
  @IsString() @Length(3, 120) legalName!: string;
  @IsOptional() @IsString() @MaxLength(40) crNumber?: string;
}

export class KycDecisionDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(400) note?: string;
}

/**
 * توثيق المتجر — صور الهوية والسجل التجاري حسّاسة، فلا تمرّ بحاوية الصور العامة إطلاقًا:
 * تُخزَّن في القاعدة بعد إعادة ترميزها (يسقط EXIF وموقع GPS)، ولا تُقرأ إلا عبر مسار يتحقق
 * من الصلاحية (مالك المتجر ومديره، أو فريق المنصة)، ولا تُخبَّأ في المتصفح. وتُحذف بعد القرار
 * بـ ٣٠ يومًا فلا تتراكم بيانات هوية لا حاجة لها.
 */
@Injectable()
export class ShopKycService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ShopKycService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly alerts: PlatformAlerts,
    private readonly push: PushService,
    private readonly cache: StorefrontCache,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const first = setTimeout(() => void this.purge().catch((e) => this.log.warn((e as Error).message)), 90_000);
    first.unref?.();
    this.timer = setInterval(() => void this.purge().catch((e) => this.log.warn((e as Error).message)), DAY);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** يحذف صور الطلبات المحسومة منذ أكثر من ٣٠ يومًا — عام للاختبار */
  async purge(now = new Date()) {
    const r = await this.prisma.shopKycDoc.deleteMany({
      where: { kyc: { status: { in: [KycStatus.Approved, KycStatus.Rejected] }, reviewedAt: { lt: new Date(now.getTime() - KYC_KEEP_DAYS * DAY) } } },
    });
    if (r.count) this.log.log(`حُذفت ${r.count} وثيقة توثيق بعد مهلة الحفظ`);
    return r.count;
  }

  // ═══ التاجر ═══════════════════════════════════════════════

  private view(k: Awaited<ReturnType<ShopKycService['find']>>, verified: boolean) {
    if (!k) return { status: null, verified, kind: 'person', legalName: '', crNumber: '', reviewNote: '', docs: [], submittedAt: null, reviewedAt: null };
    return {
      status: k.status as KycStatus,
      verified,
      kind: k.kind,
      legalName: k.legalName,
      crNumber: k.crNumber,
      reviewNote: k.reviewNote,
      submittedAt: k.submittedAt,
      reviewedAt: k.reviewedAt,
      docs: k.docs,
      keepDays: KYC_KEEP_DAYS,
    };
  }

  private find(storeId: string) {
    return this.prisma.shopKyc.findUnique({
      where: { storeId },
      include: { docs: { select: { id: true, kind: true, size: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
    });
  }

  async get(ctx: TenantContext, storeId: string) {
    const { store } = await this.access.require(ctx, storeId);
    return this.view(await this.find(storeId), store.verified);
  }

  /** المسودة أو المرفوض فقط يُعدَّلان — المعلّق عند المنصة والموثَّق مغلقان */
  private async editable(ctx: TenantContext, storeId: string) {
    const { store } = await this.access.require(ctx, storeId, { writable: true });
    const k = await this.prisma.shopKyc.findUnique({ where: { storeId } });
    if (k && k.status === KycStatus.Pending) throw new ConflictException('الطلب قيد المراجعة — انتظر قرار فريق المنصة');
    if (store.verified) throw new ConflictException('المتجر موثَّق بالفعل');
    return {
      store,
      kyc: k ?? (await this.prisma.shopKyc.create({ data: { companyId: store.companyId, storeId, kind: 'person', legalName: '' } })),
    };
  }

  async saveInfo(ctx: TenantContext, storeId: string, dto: KycInfoDto) {
    const { kyc } = await this.editable(ctx, storeId);
    await this.prisma.shopKyc.update({
      where: { id: kyc.id },
      data: { kind: dto.kind, legalName: dto.legalName.trim(), crNumber: (dto.crNumber ?? '').trim(), status: KycStatus.Draft },
    });
    return this.get(ctx, storeId);
  }

  async addDoc(ctx: TenantContext, storeId: string, kind: string, file?: UploadedBinary) {
    if (!KYC_DOC_KINDS.includes(kind as DocKind)) throw new BadRequestException('نوع الوثيقة غير معروف');
    if (!file?.buffer?.length) throw new BadRequestException('أرفق صورة الوثيقة');
    if (file.buffer.length > MAX_IMAGE_BYTES * 2) throw new BadRequestException('الصورة أكبر من ١٠ م.ب');
    const ext = sniffImage(file.buffer);
    if (!ext || ext === 'gif') throw new BadRequestException('صورة JPG أو PNG أو WebP فقط');
    let data: Buffer;
    try {
      // إعادة الترميز تُسقط EXIF (ومعه موقع التصوير) وتضبط الحجم: الوثيقة تُقرأ لا تُطبع
      data = await sharp(file.buffer, { limitInputPixels: 40_000_000 }).rotate()
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch {
      throw new BadRequestException('الصورة تالفة أو غير مكتملة');
    }
    const { store, kyc } = await this.editable(ctx, storeId);
    await this.prisma.$transaction([
      // وثيقة واحدة لكل نوع: الجديدة تستبدل القديمة
      this.prisma.shopKycDoc.deleteMany({ where: { kycId: kyc.id, kind } }),
      this.prisma.shopKycDoc.create({ data: { kycId: kyc.id, companyId: store.companyId, storeId, kind, mime: 'image/webp', size: data.length, data: new Uint8Array(data) } }),
      this.prisma.shopKyc.update({ where: { id: kyc.id }, data: { status: KycStatus.Draft } }),
    ]);
    return this.get(ctx, storeId);
  }

  async removeDoc(ctx: TenantContext, storeId: string, docId: string) {
    const { kyc } = await this.editable(ctx, storeId);
    await this.prisma.shopKycDoc.deleteMany({ where: { id: docId, kycId: kyc.id } });
    return this.get(ctx, storeId);
  }

  async submit(ctx: TenantContext, storeId: string) {
    const { store, kyc } = await this.editable(ctx, storeId);
    const docs = await this.prisma.shopKycDoc.findMany({ where: { kycId: kyc.id }, select: { kind: true } });
    const has = (k: DocKind) => docs.some((d) => d.kind === k);
    if (kyc.legalName.trim().length < 3) throw new BadRequestException('اكتب الاسم الرسمي كما في الوثيقة');
    if (!has('id_front')) throw new BadRequestException('أرفق صورة وجه الهوية');
    if (kyc.kind === 'business' && (!has('cr') || !kyc.crNumber)) throw new BadRequestException('المنشأة: أرفق السجل التجاري واكتب رقمه');
    await this.prisma.shopKyc.update({
      where: { id: kyc.id },
      data: { status: KycStatus.Pending, submittedAt: new Date(), reviewNote: '', reviewedAt: null, reviewedBy: null },
    });
    void this.alerts.raise({
      kind: 'kyc',
      title: `طلب توثيق: ${store.name}`,
      body: `${kyc.legalName} · ${kyc.kind === 'business' ? 'منشأة' : 'فرد'}`,
      link: '/platform/verification',
      data: { storeId },
    });
    return this.get(ctx, storeId);
  }

  async docBytes(ctx: TenantContext, storeId: string, docId: string) {
    await this.access.require(ctx, storeId);
    const d = await this.prisma.shopKycDoc.findFirst({ where: { id: docId, storeId } });
    if (!d) throw new NotFoundException('الوثيقة غير موجودة');
    return file(d);
  }

  // ═══ فريق المنصة ═══════════════════════════════════════════

  async platformList(status?: number) {
    const rows = await this.prisma.shopKyc.findMany({
      where: { ...(status !== undefined ? { status } : { status: { not: KycStatus.Draft } }) },
      orderBy: [{ status: 'asc' }, { submittedAt: 'asc' }],
      take: 200,
      include: {
        store: { select: { id: true, name: true, slug: true, verified: true, organization: { select: { name: true } } } },
        docs: { select: { id: true, kind: true, size: true } },
      },
    });
    const counts = await this.prisma.shopKyc.groupBy({ by: ['status'], _count: { _all: true } });
    return {
      requests: rows,
      counts: { 1: 0, 2: 0, 3: 0, ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])) } as Record<number, number>,
    };
  }

  async platformDoc(kycId: string, docId: string) {
    const d = await this.prisma.shopKycDoc.findFirst({ where: { id: docId, kycId } });
    if (!d) throw new NotFoundException('الوثيقة غير موجودة — ربما حُذفت بعد مهلة الحفظ');
    return file(d);
  }

  async decide(p: PlatformContext, kycId: string, dto: KycDecisionDto) {
    const k = await this.prisma.shopKyc.findUnique({ where: { id: kycId }, include: { store: true } });
    if (!k) throw new NotFoundException('الطلب غير موجود');
    if (k.status !== KycStatus.Pending) throw new ConflictException('حُسم هذا الطلب');
    const note = (dto.note ?? '').trim();
    if (!dto.approve && note.length < 3) throw new BadRequestException('اكتب للتاجر سبب الرفض وما يصحّحه');
    await this.prisma.$transaction([
      this.prisma.shopKyc.update({
        where: { id: kycId },
        data: { status: dto.approve ? KycStatus.Approved : KycStatus.Rejected, reviewNote: note, reviewedAt: new Date(), reviewedBy: p.userId },
      }),
      ...(dto.approve ? [this.prisma.shopStore.update({ where: { id: k.storeId }, data: { verified: true } })] : []),
    ]);
    if (dto.approve) this.cache.purge(k.store.slug);
    void this.push.toCompany(k.companyId, {
      title: dto.approve ? 'وُثّق متجرك ✓' : 'طلب التوثيق يحتاج تصحيحًا',
      body: dto.approve ? `${k.store.name} يحمل الآن شارة «متجر موثَّق»` : note.slice(0, 140),
      link: '/store/verification',
      kind: 'kyc',
      data: { storeId: k.storeId },
    }).catch(() => undefined);
    return { ok: true };
  }
}

function file(d: { data: Uint8Array; mime: string }) {
  return new StreamableFile(Buffer.from(d.data), { type: d.mime, disposition: 'inline' });
}

/** التاجر: المالك والمدير فقط — بيانات هوية لا يراها كل موظف */
@RequireRole(UserRole.Admin)
@Controller('shop/stores/:storeId/kyc')
export class ShopKycController {
  constructor(private readonly kyc: ShopKycService) {}

  @Get()
  get(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.kyc.get(ctx, storeId);
  }

  @Put()
  save(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Body() dto: KycInfoDto) {
    return this.kyc.saveInfo(ctx, storeId, dto);
  }

  @Post('docs')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES * 2, files: 1 } }))
  addDoc(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('kind') kind: string,
    @UploadedFile() file?: UploadedBinary,
  ) {
    return this.kyc.addDoc(ctx, storeId, String(kind ?? ''), file);
  }

  @Get('docs/:docId')
  @Header('Cache-Control', 'private, no-store')
  doc(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('docId', ParseUUIDPipe) docId: string) {
    return this.kyc.docBytes(ctx, storeId, docId);
  }

  @Delete('docs/:docId')
  removeDoc(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('docId', ParseUUIDPipe) docId: string) {
    return this.kyc.removeDoc(ctx, storeId, docId);
  }

  @Post('submit')
  submit(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.kyc.submit(ctx, storeId);
  }
}

@PlatformOnly()
@Controller('platform/kyc')
export class PlatformKycController {
  constructor(private readonly kyc: ShopKycService) {}

  @Get()
  list(@Platform() _p: PlatformContext, @Query('status') status?: string) {
    const s = status !== undefined && status !== '' ? Number(status) : undefined;
    return this.kyc.platformList(Number.isInteger(s) ? s : undefined);
  }

  @Get(':id/docs/:docId')
  @Header('Cache-Control', 'private, no-store')
  doc(@Platform() _p: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string) {
    return this.kyc.platformDoc(id, docId);
  }

  @Post(':id/decide')
  decide(@Platform() p: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: KycDecisionDto) {
    return this.kyc.decide(p, id, dto);
  }
}
