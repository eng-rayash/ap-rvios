import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { R2Storage, r2FromEnv } from './r2-storage';

export interface UploadedBinary {
  buffer: Buffer;
  size: number;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** سقف عدد الملفات لكل شركة — يحمي القرص من الإغراق. */
const MAX_FILES_PER_COMPANY = 3000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * النوع الحقيقي من بصمة الملف (magic bytes) لا من اسمه ولا من `Content-Type`
 * الذي يرسله العميل — كلاهما يُزوَّر. SVG مستبعد عمدًا: يحمل سكربتات.
 */
export function sniffImage(b: Buffer): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** أطول ضلع بعد إعادة الترميز — يكفي شاشة عرض كاملة ومعاينة التكبير */
const MAX_EDGE = 1600;

/**
 * يعيد ترميز الصورة WebP بأطول ضلع ١٦٠٠ بكسل، ويُسقط بياناتها الوصفية.
 *
 * لماذا في الخادم وعلى كل رفع: صورة منتج من هاتف (٣–٥ م.ب) أو PNG خام تُحمَّل
 * على شبكة جوّال بطيئة عند كل زيارة، وتُضاعف كلفة التخزين والنقل. وEXIF قد يحمل
 * موقع التاجر (GPS) فلا يُنشر مع صورة منتجه. والتدوير من EXIF يُطبَّق قبل إسقاطه
 * كي لا تنقلب صورة الهاتف.
 *
 * GIF يبقى كما هو (قد يكون متحرّكًا). وما لا يفكّه sharp يُرفض: بصمة سليمة
 * فوق محتوى تالف ليست صورة.
 */
async function normalizeImage(buf: Buffer, ext: 'jpg' | 'png' | 'webp' | 'gif') {
  if (ext === 'gif') return { buf, ext };
  try {
    const out = await sharp(buf, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return { buf: out, ext: 'webp' as const };
  } catch {
    throw new BadRequestException('الصورة تالفة أو غير مكتملة');
  }
}

/**
 * تخزين الملفات — Cloudflare R2 حين تكتمل مفاتيحه (`CF_*`)، وإلا القرص المحلي.
 * المستهلك لا يرى الفرق: `saveImage` يرجع رابطًا عامًا في الحالتين.
 *
 * `STORAGE_DRIVER=local|r2` يفرض أحدهما. والاختبارات (`NODE_ENV=test`) على
 * القرص دائمًا ما لم يُفرض غير ذلك — كي لا يكتب تشغيل الاختبارات في الحاوية الحقيقية.
 */
@Injectable()
export class UploadsService {
  readonly root = resolve(process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads'));
  private readonly r2: R2Storage | null;
  private readonly log = new Logger('Uploads');

  constructor(private readonly prisma: TenantPrismaService) {
    const cfg = r2FromEnv();
    const forced = process.env.STORAGE_DRIVER;
    const useR2 = forced ? forced === 'r2' : process.env.NODE_ENV !== 'test';
    if (forced === 'r2' && !cfg) throw new Error('STORAGE_DRIVER=r2 بلا مفاتيح CF_* كاملة');
    this.r2 = useR2 && cfg ? new R2Storage(cfg) : null;
    this.log.log(this.r2 ? `التخزين: Cloudflare R2 (${cfg!.bucket})` : `التخزين: القرص المحلي (${this.root})`);
  }

  get driver(): 'r2' | 'local' {
    return this.r2 ? 'r2' : 'local';
  }

  /** التخزين السحابي إن كان مفعّلًا — لمنظّف صور المتاجر */
  get cloud(): R2Storage | null {
    return this.r2;
  }

  private baseUrl() {
    const base = process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
    return `${base.replace(/\/$/, '')}/api/v1`;
  }

  /**
   * يحفظ صورة شركة ويرجع رابطها العام. الاسم عشوائي غير قابل للتخمين.
   *
   * `storeId` يضعها في مجلد ذلك المتجر — بعد التحقق من أنه متجر هذه الشركة،
   * فلا يكتب تاجر في مجلد متجر غيره.
   */
  async saveImage(companyId: string, file: UploadedBinary, storeId?: string, folder?: 'proofs') {
    if (!UUID.test(companyId)) throw new BadRequestException('شركة غير صالحة');
    if (!file?.buffer?.length) throw new BadRequestException('لم يُرفق ملف');
    if (file.size > MAX_IMAGE_BYTES) throw new PayloadTooLargeException('الصورة أكبر من ٥ ميغابايت');

    const sniffed = sniffImage(file.buffer);
    if (!sniffed) throw new BadRequestException('الصيغة غير مدعومة — استخدم JPG أو PNG أو WebP أو GIF');

    if (storeId !== undefined) {
      if (!UUID.test(storeId)) throw new BadRequestException('متجر غير صالح');
      const own = await this.prisma.forTenant(companyId).shopStore.findFirst({
        where: { id: storeId },
        select: { id: true },
      });
      if (!own) throw new NotFoundException('المتجر غير موجود');
    }

    const { buf, ext } = await normalizeImage(file.buffer, sniffed);
    const name = `${randomUUID()}.${ext}`;
    const mime = MIME_BY_EXT[ext];

    if (this.r2) {
      const key = storeId
        ? `stores/${storeId}/${folder ? `${folder}/` : ''}${name}`
        : `companies/${companyId}/${name}`;
      const url = await this.r2.put(key, buf, mime);
      return { url, name, size: buf.length, mime };
    }

    const dir = join(this.root, companyId);
    await mkdir(dir, { recursive: true });
    const existing = await readdir(dir).catch(() => [] as string[]);
    if (existing.length >= MAX_FILES_PER_COMPANY) {
      throw new BadRequestException('بلغت الحد الأقصى لعدد الملفات');
    }

    await writeFile(join(dir, name), buf, { flag: 'wx' });

    return {
      url: `${this.baseUrl()}/files/${companyId}/${name}`,
      name,
      size: buf.length,
      mime,
    };
  }

  /** مسار ملف للقراءة — أسماء صارمة تمنع الخروج من المجلد. */
  pathFor(companyId: string, name: string): string | null {
    if (!UUID.test(companyId) || !FILE_NAME.test(name)) return null;
    return join(this.root, companyId, name);
  }
}
