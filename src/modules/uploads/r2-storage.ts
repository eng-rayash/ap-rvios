import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * تخزين Cloudflare R2 (متوافق مع S3) — حاوية واحدة، ومجلد لكل متجر:
 *
 *   stores/<storeId>/<uuid>.<ext>      صور متجر بعينه (منتجات، شعار، غلاف، إيصالات)
 *   companies/<companyId>/<uuid>.<ext> ما سواها (صورة الملف الشخصي، المشاريع، الموقع)
 *
 * المجلد بمعرّف المتجر لا برابطه: الرابط يتغيّر حين يعيد التاجر تسمية متجره،
 * والمعرّف ثابت، فلا تتفرّق صور المتجر الواحد على مجلدين.
 *
 * الصور تُخدم من النطاق العام للحاوية (`CF_PUBLIC_URL`) مباشرةً لا عبر الباكند —
 * فلا يمرّ كل عرض لصورة منتج بخادمنا.
 */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
}

/** الإعداد من البيئة، أو `null` إن نقص شيء — فيبقى التخزين محليًا. */
export function r2FromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const cfg = {
    accountId: env.CF_ACCOUNT_ID ?? '',
    accessKeyId: env.CF_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.CF_SECRET_ACCESS_KEY ?? '',
    bucket: env.CF_BUCKET_NAME ?? '',
    publicUrl: (env.CF_PUBLIC_URL ?? '').replace(/\/+$/, ''),
  };
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

export class R2Storage {
  private readonly client: S3Client;

  constructor(private readonly cfg: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  /** يكتب الكائن ويرجع رابطه العام. الاسم عشوائي، فلا كتابة فوق ملف قائم. */
  async put(key: string, body: Buffer, mime: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: mime,
        // الاسم يتغيّر مع كل رفع، فالمحتوى تحت الرابط لا يتغيّر أبدًا
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.cfg.publicUrl}/${key}`;
  }

  /** مفتاح الكائن من رابطه العام، أو `null` إن لم يكن من هذه الحاوية. */
  keyOf(url: string): string | null {
    const base = `${this.cfg.publicUrl}/`;
    return url.startsWith(base) ? url.slice(base.length) : null;
  }

  /** كل الكائنات تحت بادئة (مجلد متجر) مع تاريخ آخر تعديل. */
  async list(prefix: string): Promise<{ key: string; modified: Date }[]> {
    const out: { key: string; modified: Date }[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, modified: o.LastModified ?? new Date(0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** حذف دفعات (حدّ S3 ألف مفتاح للطلب). */
  async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(new DeleteObjectsCommand({
        Bucket: this.cfg.bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }));
    }
  }
}
