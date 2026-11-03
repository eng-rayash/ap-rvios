import { Injectable, Logger } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { EmailService } from '../auth/email.service';
import { symbolOf } from '../shop/shop.constants';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const AZM = () => (process.env.AZMSMART_URL || 'https://azm.rvios.com').replace(/\/+$/, '');

/** رسالة بريد واحدة الشكل لكل الإشعارات — النصوص من بيانات المستخدمين تُهرَّب دائمًا */
function mail(title: string, lines: string[], cta?: { label: string; href: string }) {
  const body = lines.filter(Boolean).map((l) => `<p style="font-size:15px;line-height:1.8;margin:6px 0">${esc(l)}</p>`).join('');
  const button = cta
    ? `<p style="margin:22px 0 4px"><a href="${esc(cta.href)}" style="display:inline-block;background:#C1272D;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(cta.label)}</a></p>`
    : '';
  return {
    text: [title, '', ...lines.filter(Boolean), ...(cta ? ['', `${cta.label}: ${cta.href}`] : [])].join('\n'),
    html: `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Tahoma,Arial,sans-serif;color:#171717">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:14px;padding:28px;text-align:right">
<div style="font-weight:700;color:#C1272D;letter-spacing:.14em;direction:ltr;text-align:right">RVIOS</div>
<h1 style="font-size:20px;margin:16px 0 10px">${esc(title)}</h1>${body}${button}
</div></body></html>`,
  };
}

/**
 * إشعارات البريد للتجار وفريق المنصة. تعمل حين يُضبط Resend، ولا تُرسل في الاختبارات.
 * الفشل لا يوقف شيئًا: الطلب والمتجر قائمان، والبريد إخطار فقط.
 */
@Injectable()
export class StoreEmails {
  private readonly log = new Logger(StoreEmails.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly email: EmailService,
  ) {}

  private get enabled() {
    return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM && process.env.NODE_ENV !== 'test';
  }

  /** بريد صاحب الشركة — مالكها، ثم أي مدير */
  private async ownerOf(companyId: string) {
    const m = await this.prisma.membership.findFirst({
      where: { organizationId: companyId, isActive: true, deletedAt: null, role: { in: [0, 1] }, user: { deletedAt: null } },
      orderBy: { role: 'asc' },
      select: { user: { select: { email: true, displayName: true } } },
    });
    return m?.user ?? null;
  }

  private async send(to: string | null | undefined, subject: string, m: { html: string; text: string }) {
    if (!this.enabled || !to) return;
    const ok = await this.email.send({ to, subject, html: m.html, text: m.text });
    if (!ok) this.log.warn(`لم يُرسل بريد «${subject}»`);
  }

  /** طلب شراء جديد في متجر — لصاحبه */
  async newOrder(
    store: { name: string; companyId: string; country: string },
    order: { ref: string; custName: string; total: number; items: Array<{ name: string; qty: number }> },
  ) {
    if (!this.enabled) return;
    try {
      const owner = await this.ownerOf(store.companyId);
      const items = order.items.map((i) => `• ${i.name} × ${i.qty}`);
      await this.send(owner?.email, `طلب جديد ${order.ref} — ${store.name}`, mail(`طلب جديد في ${store.name}`, [
        `رقم الطلب: ${order.ref}`,
        order.custName ? `العميل: ${order.custName}` : '',
        ...items,
        `الإجمالي: ${order.total.toLocaleString('en-US')} ${symbolOf(store.country)}`,
        'سرعة ردّك تصنع البيع — أكّد الطلب من لوحتك.',
      ], { label: 'فتح الطلبات', href: `${AZM()}/orders` }));
    } catch (e) {
      this.log.warn(`بريد الطلب ${order.ref}: ${(e as Error).message}`);
    }
  }

  /** طلب متجر بباقة مدفوعة — للفريق ليتواصل ويفعّله، ولصاحبه تأكيدًا */
  async storeRequested(store: { name: string; slug: string; companyId: string }, total: number, currency: string) {
    if (!this.enabled) return;
    try {
      const owner = await this.ownerOf(store.companyId);
      const team = process.env.TEAM_NOTIFY_EMAIL || process.env.EMAIL_REPLY_TO;
      await this.send(team, `طلب متجر جديد — ${store.name}`, mail('طلب متجر جديد بانتظار التفعيل', [
        `المتجر: ${store.name} (${store.slug})`,
        owner ? `صاحب الطلب: ${owner.displayName} — ${owner.email}` : '',
        `الإجمالي: ${total} ${currency}`,
      ], { label: 'طلبات المتاجر', href: `${AZM()}/platform/requests` }));
      await this.send(owner?.email, `استلمنا طلب متجرك ${store.name}`, mail('استلمنا طلب متجرك', [
        `طلب متجر «${store.name}» وصل إلى فريق RVIOS.`,
        'أكمل الدفع مع الفريق على واتساب، ويتفعّل متجرك بالباقة والقالب اللذين اخترتهما. وحتى ذلك يمكنك تجهيز منتجاتك.',
      ], { label: 'فتح حسابي', href: `${AZM()}/dashboard` }));
    } catch (e) {
      this.log.warn(`بريد طلب المتجر ${store.slug}: ${(e as Error).message}`);
    }
  }

  /** فعّل الفريق المتجر — لصاحبه */
  async storeActivated(store: { name: string; slug: string; companyId: string }, url: string) {
    if (!this.enabled) return;
    try {
      const owner = await this.ownerOf(store.companyId);
      await this.send(owner?.email, `تفعّل متجرك ${store.name}`, mail('تفعّل متجرك 🎉', [
        `متجر «${store.name}» يعمل الآن بالباقة والقالب اللذين اخترتهما.`,
        `رابطه: ${url}`,
        'شارك الرابط مع عملائك، وعدّل شكله ومنتجاته من حسابك.',
      ], { label: 'فتح لوحة المتجر', href: `${AZM()}/dashboard` }));
    } catch (e) {
      this.log.warn(`بريد تفعيل ${store.slug}: ${(e as Error).message}`);
    }
  }
}
