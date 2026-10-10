/**
 * الأحداث التي يمكن الاشتراك فيها. `webhook.test` ليس هنا عمدًا: يُرسَل
 * فقط حين يطلبه التاجر من اللوحة، ولا يُشترك فيه.
 */
export const WEBHOOK_EVENTS = [
  { id: 'order.created', label: 'طلب جديد في المتجر' },
  { id: 'order.status_changed', label: 'تغيّر حالة طلب (تأكيد، إكمال، إلغاء)' },
  { id: 'order.payment_changed', label: 'تغيّر حالة دفع طلب (إيصال، تأكيد، رفض)' },
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]['id'] | 'webhook.test';

export const WEBHOOK_EVENT_IDS: string[] = WEBHOOK_EVENTS.map((e) => e.id);

/** 0=بانتظار الإرسال · 1=نجح · 2=فشل نهائيًا */
export enum DeliveryStatus {
  Pending = 0,
  Succeeded = 1,
  Failed = 2,
}

/**
 * جدول إعادة المحاولة بالثواني بعد كل فشل: دقيقة، ٥ دقائق، نصف ساعة،
 * ساعتان، ٦ ساعات. مع المحاولة الأولى = ٦ محاولات عبر نحو ٨ ساعات —
 * تكفي لتجاوز انقطاع خادم المستقبِل أو إعادة نشره دون إغراقه.
 */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = RETRY_BACKOFF_SECONDS.length + 1;

/** بعد هذا العدد من المحاولات الفاشلة المتتالية تُعطَّل النقطة تلقائيًا. */
export const DISABLE_AFTER_FAILURES = 30;

/** مهلة طلب الإرسال الواحد. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** مدة «حجز» الإرسال عند التقاطه — تمنع عاملين من إرسال الحدث نفسه مرتين. */
export const CLAIM_LEASE_MS = 60_000;

/** سجل الإرسالات يُحذف بعد هذه المدة. */
export const DELIVERY_RETENTION_DAYS = 30;
