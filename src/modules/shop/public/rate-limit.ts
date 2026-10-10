import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * حدّ معدّل بسيط في الذاكرة للمسارات العامة (طلبات، إيصالات).
 *
 * يكفي نسخة واحدة من الخادم؛ عند تعدّد النسخ يُستبدل بمخزن مشترك (Redis).
 * المفتاح يجمع الغرض والعنوان والمتجر، فطلبات متجر لا تحجب متجرًا آخر.
 */
@Injectable()
export class PublicRateLimit {
  private readonly hits = new Map<string, { count: number; reset: number }>();

  check(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    const row = this.hits.get(key);
    if (!row || row.reset < now) {
      this.hits.set(key, { count: 1, reset: now + windowMs });
      this.sweep(now);
      return;
    }
    row.count += 1;
    if (row.count > max) {
      throw new HttpException(
        'محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * حدّ على **الإخفاقات** وحدها (محاولات الدخول): `assertOpen` قبل المحاولة،
   * و`fail` بعد إخفاقها، و`clear` بعد نجاحها. فمن يكتب كلمة مروره صحيحة لا
   * يُحسب عليه شيء، ومن يخمّن يُوقَف بعد `max` إخفاقًا حتى تنقضي النافذة.
   */
  assertOpen(key: string, max: number): void {
    const row = this.hits.get(key);
    if (row && row.reset >= Date.now() && row.count >= max) {
      const minutes = Math.max(1, Math.ceil((row.reset - Date.now()) / 60_000));
      throw new HttpException(
        `محاولات دخول خاطئة كثيرة — أعد المحاولة بعد ${minutes} دقيقة`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  fail(key: string, windowMs: number): void {
    const now = Date.now();
    const row = this.hits.get(key);
    if (!row || row.reset < now) {
      this.hits.set(key, { count: 1, reset: now + windowMs });
      this.sweep(now);
    } else {
      row.count += 1;
    }
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  /** تنظيف عرضي كي لا ينمو الجدول بلا حدّ */
  private sweep(now: number): void {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}
