import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { Public, RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { MAX_IMAGE_BYTES, MIME_BY_EXT, UploadsService, type UploadedBinary } from './uploads.service';

@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * رفع صورة إلى شركتي. الحقل `file`. الموظف فأعلى. و`?storeId=` يضعها في
   * مجلد ذلك المتجر في التخزين السحابي.
   *
   * حد multer هنا أعلى بكثير من `MAX_IMAGE_BYTES` عمدًا: هو سقف حماية من
   * إغراق الذاكرة لا الحد التجاري. القرار «الصورة أكبر من ٥ ميغابايت»
   * يقع في [UploadsService.saveImage] وحده، فيرجع رسالة عربية واضحة
   * (٤١٣) بدل أن يرمي multer خطأه الخام (يُترجَم عادة إلى ٥٠٠).
   */
  @RequireRole(UserRole.Employee)
  @Post('uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES * 4, files: 1 } }))
  upload(
    @Tenant() ctx: TenantContext,
    @UploadedFile() file?: UploadedBinary,
    @Query('storeId') storeId?: string,
  ) {
    if (!file) throw new BadRequestException('لم يُرفق ملف (الحقل file)');
    return this.uploads.saveImage(ctx.companyId, file, storeId || undefined);
  }

  /**
   * تقديم الصور علنًا: واجهات المتاجر تعرضها لزوّار بلا حساب. الأمان في
   * أن الأسماء عشوائية، وأن المسار لا يقبل غير النمط الصارم، وأن الرأس
   * `nosniff` يمنع المتصفح من تفسير الملف كغير صورة.
   */
  @Public()
  @Get('files/:companyId/:name')
  async file(
    @Param('companyId') companyId: string,
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const path = this.uploads.pathFor(companyId, name);
    if (!path) throw new NotFoundException();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();

    res.set({
      'Content-Type': MIME_BY_EXT[extname(name).slice(1)],
      'Content-Length': String(info.size),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return new StreamableFile(createReadStream(path));
  }
}
