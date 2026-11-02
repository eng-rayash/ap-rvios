import { Injectable, Logger } from '@nestjs/common';

/**
 * منصة المتاجر تخزّن صفحة كل متجر دقيقة (ISR) — وصفحة «غير موجود» أثناء التعليق كذلك، فيبقى
 * المتجر المُعاد تفعيله مختفيًا حتى يتجدد التخزين. بعد كل تغيير يراه الزائر يُطلب تجديده فورًا.
 * بلا `STOREFRONT_URL` و`REVALIDATE_SECRET` (التطوير والاختبارات) لا يُرسل شيء.
 */
@Injectable()
export class StorefrontCache {
  private readonly log = new Logger(StorefrontCache.name);

  purge(...slugs: (string | null | undefined)[]): void {
    const base = (process.env.STOREFRONT_URL ?? '').replace(/\/+$/, '');
    const secret = process.env.REVALIDATE_SECRET;
    if (!base || !secret) return;
    for (const slug of new Set(slugs.filter((s): s is string => !!s))) {
      // لا يُنتظر: تجديد التخزين لا يؤخر حفظ التاجر ولا يُفشله
      void fetch(`${base}/api/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
        body: JSON.stringify({ slug }),
      })
        .then((r) => {
          if (!r.ok) this.log.warn(`رفضت منصة المتاجر تجديد ${slug}: ${r.status}`);
        })
        .catch((e: Error) => this.log.warn(`تعذّر تجديد صفحة ${slug}: ${e.message}`));
    }
  }
}
