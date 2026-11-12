import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  UploadedFile,
  UseInterceptors,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { Platform, PlatformOnly, RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import {
  PlatformContext,
  TenantContext,
  UserRole,
} from '../../../common/tenant/tenant-context';
import { FileInterceptor } from '@nestjs/platform-express';

import { MAX_IMAGE_BYTES, UploadedBinary, UploadsService } from '../../uploads/uploads.service';
import { StoreAppearanceService } from './store-appearance.service';
import { StoreRequestsService } from './store-requests.service';
import { CreateStoreDto, SaveAppearanceDto, SaveStoreExtrasDto, SetStoreStatusDto, UpdateStoreDto } from './stores.dto';
import { StoresService } from './stores.service';

/** متاجر الشركة — قراءة لأي عضو، والكتابة للإدارة فما فوق. */
@Controller('shop/stores')
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly appearance: StoreAppearanceService,
    private readonly requests: StoreRequestsService,
  ) {}

  @Get()
  list(@Tenant() ctx: TenantContext) {
    return this.stores.list(ctx);
  }

  /** فحص فوري لتوفر الرابط — قبل `:storeId` كي لا يُلتقط اسمًا لمتجر. */
  @Get('slug/check')
  checkSlug(
    @Tenant() _ctx: TenantContext,
    @Query('q') q = '',
    @Query('except') except?: string,
  ) {
    if (!q.trim()) {
      return { slug: '', ok: false, reason: 'اكتب اسم متجرك', suggestion: null };
    }
    return this.stores.checkSlug(q, except);
  }

  @Get(':storeId')
  get(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.stores.get(ctx, storeId);
  }

  @RequireRole(UserRole.Admin)
  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateStoreDto) {
    // باقة مدفوعة = طلب يفعّله فريق المنصة بعد الدفع
    return dto.plan ? this.requests.create(ctx, dto) : this.stores.create(ctx, dto);
  }

  @RequireRole(UserRole.Admin)
  @Patch(':storeId')
  update(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: UpdateStoreDto,
  ) {
    return this.stores.update(ctx, storeId, dto);
  }

  /** حفظ «شكل المتجر» — يقفل التعديل أسبوعًا */
  @RequireRole(UserRole.Admin)
  @Put(':storeId/appearance')
  saveAppearance(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SaveAppearanceDto,
  ) {
    return this.appearance.save(ctx, storeId, dto);
  }

  /** شريط الإعلان والسياسات وزر واتساب ووصف البحث — بلا قفل الأسبوع */
  @RequireRole(UserRole.Admin)
  @Put(':storeId/extras')
  saveExtras(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SaveStoreExtrasDto,
  ) {
    return this.appearance.saveExtras(ctx, storeId, dto);
  }

  @RequireRole(UserRole.Admin)
  @Delete(':storeId')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('confirm') confirm?: string,
  ) {
    return this.stores.remove(ctx, storeId, confirm);
  }
}

/** متاجر كل الشركات — فريق المنصة فقط. */
@PlatformOnly()
@Controller('platform/shop-stores')
export class PlatformStoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly appearance: StoreAppearanceService,
    private readonly requests: StoreRequestsService,
    private readonly uploads: UploadsService,
  ) {}

  /** طلبات المتاجر بالباقات المدفوعة — بانتظار الدفع والتفعيل */
  @Get('requests')
  listRequests(@Platform() _ctx: PlatformContext) {
    return this.requests.list();
  }

  @Post(':storeId/activate')
  activate(
    @Platform() ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { paymentReference?: string },
  ) {
    return this.requests.activate(storeId, ctx, typeof body?.paymentReference === 'string' ? body.paymentReference.slice(0, 200) : undefined);
  }

  @Post(':storeId/reject')
  reject(
    @Platform() ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { reason?: string },
  ) {
    return this.requests.reject(storeId, ctx, typeof body?.reason === 'string' ? body.reason.slice(0, 300) : undefined);
  }

  /** محرر «شكل المتجر» من لوحة المنصة: المتجر ومنتجاته */
  @Get(':storeId/editor')
  editor(@Platform() ctx: PlatformContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.appearance.teamEditor(storeId, ctx);
  }

  /** حفظ شكل متجر من لوحة المنصة — بلا قفل الأسبوع */
  @Put(':storeId/appearance')
  saveAppearance(
    @Platform() ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SaveAppearanceDto,
  ) {
    return this.appearance.teamSave(storeId, ctx, dto);
  }

  @Put(':storeId/extras')
  saveExtras(
    @Platform() ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SaveStoreExtrasDto,
  ) {
    return this.appearance.teamSaveExtras(storeId, ctx, dto);
  }

  /** رفع صورة إلى مجلد متجر — لمحرر الشكل في لوحة المنصة */
  @Post(':storeId/uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES * 4, files: 1 } }))
  async upload(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @UploadedFile() file?: UploadedBinary,
  ) {
    if (!file) throw new BadRequestException('لم يُرفق ملف (الحقل file)');
    const store = await this.stores.platformStore(storeId);
    return this.uploads.saveImage(store.companyId, file, store.id);
  }

  /** حذف متجر نهائيًا — للمدير العام وحده */
  @Delete(':storeId')
  remove(@Platform() ctx: PlatformContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    if (ctx.platformRole !== 2) throw new ForbiddenException('حذف المتاجر للمدير العام وحده');
    return this.stores.platformDelete(storeId);
  }

  @Get()
  list(@Platform() _ctx: PlatformContext, @Query('q') q?: string) {
    return this.stores.platformList(q);
  }

  @Patch(':storeId/status')
  status(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SetStoreStatusDto,
  ) {
    return this.stores.platformSetStatus(storeId, dto.suspended);
  }

  /** يفتح تعديل «شكل المتجر» قبل انتهاء أسبوع القفل */
  @Post(':storeId/appearance-unlock')
  unlockAppearance(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.appearance.unlock(storeId);
  }

  /** بطاقة المتجر الكاملة: الشركة والمالك والاشتراك والأرقام والفواتير */
  @Get(':storeId/overview')
  overview(@Platform() _ctx: PlatformContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.stores.platformOverview(storeId);
  }

  /** تغيير القالب مباشرة — المدفوع يُمنح للمتجر */
  @Patch(':storeId/template')
  setTemplate(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { template?: string },
  ) {
    return this.stores.platformSetTemplate(storeId, String(body?.template ?? ''));
  }

  /** شارة «موثَّق» — تمنحها الإدارة بعد المراجعة. */
  @Patch(':storeId/verified')
  verified(
    @Platform() _ctx: PlatformContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { verified: boolean },
  ) {
    return this.stores.platformSetVerified(storeId, !!body.verified);
  }
}
