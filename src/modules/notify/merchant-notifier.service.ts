import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { symbolOf } from '../shop/shop.constants';

/**
 * إشعارات التاجر عبر واتساب Cloud API — طلب جديد وتذكيرات الاشتراك.
 *
 * القنوات سلسلة تُجرَّب بالترتيب حتى تنجح واحدة (`NOTIFY_CHANNELS`):
 *   console            الافتراضي — يطبع الإشعار (تطوير واختبارات)
 *   whatsapp           Meta Cloud API
 *   whatsapp,console   يسقط إلى الطباعة إن فشل واتساب
 *
 * سرعة ردّ التاجر هي عنق الزجاجة الحقيقي لمتجر يبيع عبر واتساب: طلب لا
 * يعلم به التاجر لا قيمة له. لكن الإشعار تحسين لا شرط — فشله لا يُسقط
 * الطلب أبدًا، ولوحة التحكم تبقى مصدر الحقيقة.
 *
 * نُقلت من خادم منصة المتاجر القديم (`server/notify.js`) مع ترجمة أخطاء
 * Meta كما هي: الرد الخام «(#132001) Template not found» لا يفيد من
 * يقرأ السجل عند الثالثة فجرًا.
 */
@Injectable()
export class MerchantNotifier {
  private readonly logger = new Logger(MerchantNotifier.name);

  private get channels(): string[] {
    return (process.env.NOTIFY_CHANNELS ?? 'console')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  }

  private get wa() {
    return {
      token: process.env.META_TOKEN ?? '',
      phoneId: process.env.WA_PHONE_ID ?? '',
      appSecret: process.env.META_APP_SECRET ?? '',
      version: process.env.WA_API_VERSION ?? 'v21.0',
    };
  }

  /** حالة القنوات — للسجل عند الإقلاع وللتشخيص. */
  status(): string {
    return this.channels
      .map((c) => {
        if (c === 'console') return 'console (يُطبع في السجل)';
        if (c === 'whatsapp') {
          const { token, phoneId, appSecret } = this.wa;
          if (!token || !phoneId) return 'whatsapp ✖ ينقصه META_TOKEN/WA_PHONE_ID';
          return `whatsapp ✓ (رقم ${phoneId} · ${appSecret ? 'موقَّع' : 'بلا توقيع'})`;
        }
        return `${c} ✖ غير معروف`;
      })
      .join(' ← ');
  }

  /**
   * رسالة نصية لرقم واتساب المتجر. ترمي إن فشلت كل القنوات — المستدعي
   * (مثل التذكيرات) يحتاج أن يعرف كي لا يعلّم التذكير «مُرسَلًا».
   */
  async notify(store: { name: string; whatsapp: string }, text: string): Promise<{ provider: string }> {
    const failures: string[] = [];

    for (const channel of this.channels) {
      if (channel === 'whatsapp') {
        const { token, phoneId } = this.wa;
        if (!token || !phoneId || !store.whatsapp) {
          failures.push('whatsapp: غير مضبوط');
          continue;
        }
        try {
          await this.graph(`${phoneId}/messages`, {
            messaging_product: 'whatsapp',
            // الأرقام مخزّنة E.164 بلا «+» — لا يُركَّب رمز دولة فوق رمز
            to: store.whatsapp,
            type: 'text',
            text: { body: text },
          });
          return { provider: 'whatsapp' };
        } catch (err) {
          failures.push(`whatsapp: ${(err as Error).message}`);
        }
      }

      if (channel === 'console') {
        if (failures.length) this.logger.warn(`تعذّرت القنوات: ${failures.join(' · ')}`);
        this.logger.log(`📣 ${store.name} (${store.whatsapp || '—'}):\n${text}`);
        return { provider: 'console' };
      }
    }

    throw new Error(failures.join(' · ') || 'لا قناة إشعار مضبوطة');
  }

  /** إشعار طلب جديد — لا يرمي أبدًا. */
  async newOrder(
    store: { name: string; whatsapp: string; country: string },
    order: { ref: string; custName: string; total: number; items: Array<{ name: string; qty: number }> },
  ): Promise<void> {
    const text = [
      `طلب جديد في ${store.name}`,
      '',
      `رقم الطلب: ${order.ref}`,
      order.custName ? `العميل: ${order.custName}` : '',
      '',
      order.items.map((i) => `• ${i.name} × ${i.qty}`).join('\n'),
      '',
      `الإجمالي: ${order.total.toLocaleString('en-US')} ${symbolOf(store.country)}`,
      '',
      'افتح لوحتك لتأكيد الطلب.',
    ]
      .filter((l, i, all) => l !== '' || (all[i - 1] ?? '') !== '')
      .join('\n');

    try {
      await this.notify(store, text);
    } catch (err) {
      this.logger.warn(`تعذّر إشعار ${store.name} بالطلب ${order.ref}: ${(err as Error).message}`);
    }
  }

  // ─── Graph API ───

  /** توقيع الرمز بسرّ التطبيق: رمز مسروق من السجلات لا يعمل من جهاز آخر. */
  private appSecretProof(token: string): string | null {
    const secret = this.wa.appSecret;
    return secret ? createHmac('sha256', secret).update(token).digest('hex') : null;
  }

  private async graph(path: string, payload: unknown): Promise<unknown> {
    const { token, version } = this.wa;
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    const proof = this.appSecretProof(token);
    if (proof) url.searchParams.set('appsecret_proof', proof);

    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // بلا مهلة يعلّق الإرسال حتى تستسلم الشبكة
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(explainMetaError(res.status, body));
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
}

const META_HINTS: Record<number, string> = {
  190: 'الرمز منتهٍ أو مُبطَل — أنشئ رمزًا دائمًا من مستخدم نظام في لوحة Meta',
  100: 'معرّف الرقم (WA_PHONE_ID) غير صحيح أو لا ينتمي لهذا التطبيق',
  131030: 'الرقم المستقبِل غير مُدرج في قائمة أرقام الاختبار — أضفه في لوحة Meta أو انقل التطبيق للوضع المباشر',
  132001: 'القالب غير موجود أو غير معتمد بهذه اللغة',
  133010: 'الرقم غير مسجَّل في Cloud API — سجّله من WhatsApp Manager قبل الإرسال',
  132000: 'عدد المتغيّرات لا يطابق ما يتوقّعه القالب المعتمد',
  131047: 'انقضت نافذة الـ٢٤ ساعة — لا يمكن إرسال رسالة حرّة، يلزم قالب معتمد',
  131056: 'تجاوزت حدّ التكرار لهذا الرقم — أمهله قليلًا',
  80007: 'بلغت حدّ معدّل الإرسال في حسابك',
};

export function explainMetaError(status: number, body: string): string {
  let err: { code?: number; error_subcode?: number; message?: string } | null = null;
  try {
    err = JSON.parse(body)?.error ?? null;
  } catch {
    /* ليس JSON */
  }
  const code = err?.code;
  const hint = (code !== undefined && META_HINTS[code]) || (err?.error_subcode === 2494049 ? 'الحساب في وضع الاختبار' : null);
  const msg = err?.message ?? body.slice(0, 200);
  return `واتساب رفض الإرسال (${status}${code ? `/${code}` : ''}): ${msg}${hint ? ` — ${hint}` : ''}`;
}
