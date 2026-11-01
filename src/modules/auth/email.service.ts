import { Injectable, Logger } from '@nestjs/common';

const RESEND_URL = 'https://api.resend.com/emails';

/** البريد الصادر عبر Resend. لا يعرف شيئًا عن محتوى الرسائل غير ما يُمرَّر له. */
@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);

  /** يعيد `false` عند الفشل: المستدعي يقرر، ولا يصل نص الخطأ إلى المستخدم */
  async send(input: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!key || !from) {
      this.log.error('البريد غير مضبوط: RESEND_API_KEY و EMAIL_FROM مطلوبان');
      return false;
    }
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
        }),
      });
      if (res.ok) return true;
      this.log.error(`رفض Resend الرسالة: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      this.log.error(`تعذّر الاتصال بـResend: ${(e as Error).message}`);
    }
    return false;
  }
}

const COPY = {
  verify: { subject: 'رمز التحقق من RVIOS', lead: 'استخدم هذا الرمز لإكمال الدخول إلى حسابك في عزم سمارت:' },
  reset: { subject: 'رمز إعادة تعيين كلمة المرور', lead: 'استخدم هذا الرمز لتعيين كلمة مرور جديدة لحسابك في عزم سمارت:' },
};

/** الرسالة مضمَّنة التنسيق وبلا صور خارجية: تصل كما هي في كل برامج البريد */
export function codeEmail(kind: keyof typeof COPY, code: string, minutes: number) {
  const { subject, lead } = COPY[kind];
  const note = `الرمز صالح ${minutes} دقائق. إن لم تطلبه فتجاهل هذه الرسالة، ولا تشاركه مع أحد — فريق RVIOS لن يطلبه منك.`;
  return {
    subject: `${subject}: ${code}`,
    text: `${lead}\n\n${code}\n\n${note}`,
    html: `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Tahoma,Arial,sans-serif;color:#171717">
<div style="max-width:460px;margin:auto;background:#fff;border-radius:14px;padding:28px;text-align:right">
<div style="font-weight:700;color:#C1272D;letter-spacing:.14em;direction:ltr;text-align:right">RVIOS</div>
<p style="font-size:15px;line-height:1.8;margin:18px 0 12px">${lead}</p>
<div dir="ltr" style="font-size:32px;font-weight:700;letter-spacing:.32em;text-align:center;background:#f4f1ea;border-radius:10px;padding:16px">${code}</div>
<p style="font-size:13px;line-height:1.8;color:#6b6b6b;margin:18px 0 0">${note}</p>
</div></body></html>`,
  };
}
