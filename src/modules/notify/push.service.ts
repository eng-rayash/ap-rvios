import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';

export interface PushMessage {
  title: string;
  body: string;
  /** مسار يفتحه التطبيق عند الضغط: `/orders/AZ-1042` */
  link?: string;
  /** يجمع الإشعارات المتشابهة في الجهاز: order · store_request… */
  kind?: string;
  data?: Record<string, string>;
}

/**
 * إشعارات الدفع عبر Firebase Cloud Messaging (HTTP v1) — لتطبيق عزم وتطبيق RVOS.
 *
 * يعمل حين تُضبط ثلاثة متغيرات من حساب خدمة Firebase:
 *   FCM_PROJECT_ID · FCM_CLIENT_EMAIL · FCM_PRIVATE_KEY (بأسطر `\n`)
 * وبدونها يصمت: التنبيه داخل التطبيق وفي اللوحة يبقى مصدر الحقيقة، والدفع إخطار فقط.
 * الرمز الذي يرفضه FCM (UNREGISTERED) يُحذف كي لا نرسل لجهاز ميت إلى الأبد.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private token: { value: string; until: number } | null = null;

  constructor(private readonly prisma: TenantPrismaService) {}

  private get cfg() {
    return {
      project: process.env.FCM_PROJECT_ID ?? '',
      email: process.env.FCM_CLIENT_EMAIL ?? '',
      key: (process.env.FCM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    };
  }

  get ready(): boolean {
    const c = this.cfg;
    return !!(c.project && c.email && c.key) && process.env.NODE_ENV !== 'test';
  }

  status(): string {
    return this.ready ? `fcm ✓ (${this.cfg.project})` : 'fcm ✖ ينقصه FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY';
  }

  /** يسجّل جهازًا أو يجدّده — الرمز نفسه قد ينتقل لمستخدم آخر على الجهاز ذاته. */
  async register(userId: string, input: { token: string; platform?: string; app?: string; companyId?: string | null }) {
    const token = input.token.trim().slice(0, 400);
    const platform = ['android', 'ios', 'web'].includes(input.platform ?? '') ? input.platform! : 'android';
    const app = input.app === 'rvos' ? 'rvos' : 'azm';
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { token, userId, platform, app, companyId: input.companyId ?? null },
      update: { userId, platform, app, companyId: input.companyId ?? null, lastSeenAt: new Date() },
    });
    return { ok: true };
  }

  async unregister(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
    return { ok: true };
  }

  /** لكل أجهزة مستخدمين بعينهم (فريق المنصة مثلًا). لا يرمي أبدًا. */
  async toUsers(userIds: string[], msg: PushMessage, app?: 'azm' | 'rvos'): Promise<number> {
    if (!this.ready || !userIds.length) return 0;
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds }, ...(app ? { app } : {}) },
      select: { token: true },
    });
    return this.fanout(devices.map((d) => d.token), msg);
  }

  /** لأجهزة أعضاء شركة (صاحب المتجر وفريقه) في تطبيق عزم. لا يرمي أبدًا. */
  async toCompany(companyId: string, msg: PushMessage): Promise<number> {
    if (!this.ready) return 0;
    const members = await this.prisma.membership.findMany({
      where: { organizationId: companyId, isActive: true, deletedAt: null },
      select: { userId: true },
    });
    const devices = await this.prisma.deviceToken.findMany({
      where: {
        app: 'azm',
        userId: { in: members.map((m) => m.userId) },
        // جهاز اختار شركة أخرى لا يُزعَج بطلبات هذه
        OR: [{ companyId: null }, { companyId }],
      },
      select: { token: true },
    });
    return this.fanout(devices.map((d) => d.token), msg);
  }

  private async fanout(tokens: string[], msg: PushMessage): Promise<number> {
    let sent = 0;
    for (const token of [...new Set(tokens)].slice(0, 200)) {
      try {
        if (await this.send(token, msg)) sent++;
      } catch (e) {
        this.log.warn(`إشعار دفع: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async send(token: string, msg: PushMessage): Promise<boolean> {
    const access = await this.accessToken();
    const data: Record<string, string> = { ...(msg.data ?? {}) };
    if (msg.link) data.link = msg.link;
    if (msg.kind) data.kind = msg.kind;
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.cfg.project}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: msg.title.slice(0, 120), body: msg.body.slice(0, 400) },
          data,
          android: { priority: 'HIGH', notification: { channel_id: msg.kind === 'order' ? 'orders' : 'general', sound: 'default' } },
          apns: { payload: { aps: { sound: 'default' } } },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    const body = await res.text();
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(body)) {
      await this.prisma.deviceToken.deleteMany({ where: { token } });
      return false;
    }
    throw new Error(`FCM ${res.status}: ${body.slice(0, 160)}`);
  }

  /** رمز OAuth من حساب الخدمة (JWT موقَّع RS256) — يُحفظ حتى قبيل انتهائه. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const { email, key } = this.cfg;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`رفض Google رمز حساب الخدمة (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in - 120) * 1000 };
    return j.access_token;
  }
}
