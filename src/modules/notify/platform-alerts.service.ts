import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { EmailService } from '../auth/email.service';
import { MerchantNotifier } from './merchant-notifier.service';
import { PushService } from './push.service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const AZM = () => (process.env.AZMSMART_URL || 'https://azm.rvios.com').replace(/\/+$/, '');

export type AlertKind = 'store_request' | 'invoice_proof' | 'custom_store' | 'contact' | 'store_created';

export interface AlertInput {
  kind: AlertKind;
  title: string;
  body?: string;
  /** مسار داخل عزم سمارت: `/platform/requests` */
  link?: string;
  data?: Record<string, string | number | null>;
}

/**
 * تنبيهات فريق المنصة — «وصلنا شيء يحتاج تصرّفًا».
 *
 * كل تنبيه يُحفظ في صندوق مشترك (`platform_alerts`) تقرؤه لوحة المنصة وتطبيق RVOS،
 * ثم يُبثّ لما ضُبط من القنوات:
 *   • دفع (FCM) لأجهزة فريق المنصة في تطبيق RVOS
 *   • بريد إلى `TEAM_NOTIFY_EMAIL` وإلى قائمة «notify.emails» في إعدادات المنصة
 *   • واتساب إلى أرقام «notify.whatsapp» في إعدادات المنصة (Cloud API)
 * لا يرمي أبدًا: فشل الإخطار لا يُسقط طلب العميل.
 */
@Injectable()
export class PlatformAlerts {
  private readonly log = new Logger(PlatformAlerts.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly push: PushService,
    private readonly email: EmailService,
    private readonly wa: MerchantNotifier,
  ) {}

  async raise(a: AlertInput): Promise<void> {
    try {
      await this.prisma.platformAlert.create({
        data: {
          kind: a.kind,
          title: a.title.slice(0, 200),
          body: (a.body ?? '').slice(0, 2000),
          link: a.link ?? null,
          data: (a.data ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.log.warn(`حفظ التنبيه: ${(e as Error).message}`);
    }
    if (process.env.NODE_ENV === 'test') return;
    await Promise.allSettled([this.toDevices(a), this.toEmail(a), this.toWhatsApp(a)]);
  }

  private async setting(key: string): Promise<string[]> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    const v = typeof row?.value === 'string' ? row.value : '';
    return v.split(/[,\n،]/).map((x) => x.trim()).filter(Boolean);
  }

  private async toDevices(a: AlertInput) {
    const staff = await this.prisma.user.findMany({ where: { isPlatformStaff: true, deletedAt: null }, select: { id: true } });
    await this.push.toUsers(staff.map((s) => s.id), { title: a.title, body: a.body ?? '', link: a.link, kind: a.kind }, 'rvos');
  }

  private async toEmail(a: AlertInput) {
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
    const list = new Set([process.env.TEAM_NOTIFY_EMAIL ?? '', ...(await this.setting('notify.emails'))].filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)));
    if (!list.size) return;
    const href = a.link ? `${AZM()}${a.link}` : `${AZM()}/platform`;
    const lines = (a.body ?? '').split('\n').filter(Boolean).map((l) => `<p style="font-size:15px;line-height:1.8;margin:6px 0">${esc(l)}</p>`).join('');
    const html = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Tahoma,Arial,sans-serif;color:#171717">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:14px;padding:28px;text-align:right">
<div style="font-weight:700;color:#C1272D;letter-spacing:.14em;direction:ltr;text-align:right">RVIOS · فريق المنصة</div>
<h1 style="font-size:20px;margin:16px 0 10px">${esc(a.title)}</h1>${lines}
<p style="margin:22px 0 4px"><a href="${esc(href)}" style="display:inline-block;background:#C1272D;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">فتح في لوحة المنصة</a></p>
</div></body></html>`;
    for (const to of list) {
      await this.email.send({ to, subject: a.title, html, text: `${a.title}\n\n${a.body ?? ''}\n\n${href}` });
    }
  }

  private async toWhatsApp(a: AlertInput) {
    const numbers = (await this.setting('notify.whatsapp')).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 9);
    if (!numbers.length) return;
    const href = a.link ? `${AZM()}${a.link}` : `${AZM()}/platform`;
    const text = [`🔔 ${a.title}`, '', a.body ?? '', '', href].join('\n').replace(/\n{3,}/g, '\n\n');
    for (const n of numbers) {
      try {
        await this.wa.notify({ name: 'فريق RVIOS', whatsapp: n }, text);
      } catch (e) {
        this.log.warn(`واتساب الفريق ${n.slice(-4)}: ${(e as Error).message}`);
      }
    }
  }

  // ─── الصندوق المشترك ───

  async list(opts: { unread?: boolean; page?: number }) {
    const take = 30;
    const page = Math.max(1, opts.page ?? 1);
    const where = opts.unread ? { readAt: null } : {};
    const [rows, total, unread] = await Promise.all([
      this.prisma.platformAlert.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
      this.prisma.platformAlert.count({ where }),
      this.prisma.platformAlert.count({ where: { readAt: null } }),
    ]);
    return { items: rows, total, unread, page, pages: Math.max(1, Math.ceil(total / take)) };
  }

  async unread() {
    return { unread: await this.prisma.platformAlert.count({ where: { readAt: null } }) };
  }

  async markRead(id: string, userId: string) {
    await this.prisma.platformAlert.updateMany({ where: { id, readAt: null }, data: { readAt: new Date(), readById: userId } });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    const r = await this.prisma.platformAlert.updateMany({ where: { readAt: null }, data: { readAt: new Date(), readById: userId } });
    return { updated: r.count };
  }
}
