import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { PublicRateLimit } from '../shop/public/rate-limit';
import { EmailService, codeEmail } from './email.service';

export type CodePurpose = 'verify' | 'reset';

const CODE_MINUTES = 10;
/** الرمز يُحرق بعد خمس محاولات: ستة أرقام لا تصمد أمام تخمين مفتوح */
const MAX_ATTEMPTS = 5;
/** إعادة الإرسال تثبت كلمة المرور بدخولٍ حديث، فلا تصير بابًا لإغراق بريد أحد برسائل */
const RESEND_WINDOW = 30 * 60_000;
const COOLDOWN = 60_000;
const SENDS_PER_HOUR = 6;

/**
 * رموز البريد: تُخزَّن مجزَّأة، ولكل مستخدم رمز واحد نشط لكل غرض.
 * `EMAIL_OTP_ENABLED=1` يفعّلها — فلا يُحجب أحد عن حسابه قبل أن يصل البريد فعلًا.
 */
@Injectable()
export class EmailCodesService {
  private readonly log = new Logger(EmailCodesService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly email: EmailService,
    private readonly limit: PublicRateLimit,
  ) {}

  get enabled() {
    return process.env.EMAIL_OTP_ENABLED === '1';
  }

  private hash(userId: string, purpose: string, code: string) {
    return createHmac('sha256', process.env.JWT_SECRET ?? '').update(`${userId}:${purpose}:${code}`).digest();
  }

  /** يعيد `false` إن لم تصل الرسالة إلى Resend. طلب متكرر خلال الدقيقة يكتفي بالرمز الساري. */
  async issue(user: { id: string; email: string }, purpose: CodePurpose): Promise<boolean> {
    const row = await this.prisma.emailCode.findUnique({ where: { userId_purpose: { userId: user.id, purpose } } });
    if (row && !row.consumedAt && Date.now() - row.sentAt.getTime() < COOLDOWN && row.attempts < MAX_ATTEMPTS) return true;

    // الحدّ يُحسب هنا لا في الطلب: تخطي المهلة أعلاه لا يرسل شيئًا
    const key = `otp:send:${user.id}`;
    const quota = Number(process.env.EMAIL_OTP_HOURLY) || SENDS_PER_HOUR;
    try {
      this.limit.check(key, quota, 60 * 60_000);
    } catch {
      this.log.warn(`بلغ مستخدم حد رموز البريد في الساعة: ${user.id}`);
      return true; // الرمز الأخير ما زال في بريده؛ الرسالة لا تكشف الحدّ
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const data = {
      codeHash: this.hash(user.id, purpose, code).toString('hex'),
      attempts: 0,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      consumedAt: null,
    };
    await this.prisma.emailCode.upsert({
      where: { userId_purpose: { userId: user.id, purpose } },
      create: { userId: user.id, purpose, ...data },
      update: data,
    });
    const m = codeEmail(purpose, code, CODE_MINUTES);
    return this.email.send({ to: user.email, subject: m.subject, html: m.html, text: m.text });
  }

  /** رمز تحقق جديد لمن أثبت كلمة مروره قبل قليل — بلا إثبات لا يُرسل شيء، والردّ نفسه دائمًا */
  async resendVerify(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, email: true, deletedAt: true } });
    if (!user || user.deletedAt) return;
    const row = await this.prisma.emailCode.findUnique({ where: { userId_purpose: { userId: user.id, purpose: 'verify' } } });
    if (!row || row.consumedAt || Date.now() - row.sentAt.getTime() > RESEND_WINDOW) return;
    await this.issue(user, 'verify');
  }

  /** يستهلك الرمز أو يرمي — الرسالة واحدة لكل سبب، فلا يُعرف أيها حصل */
  async consume(userId: string | undefined, purpose: CodePurpose, code: string): Promise<void> {
    const wrong = new BadRequestException({ message: 'الرمز غير صحيح أو انتهت صلاحيته', code: 'CODE_INVALID' });
    if (!userId) throw wrong;
    const row = await this.prisma.emailCode.findUnique({ where: { userId_purpose: { userId, purpose } } });
    if (!row || row.consumedAt || row.expiresAt < new Date() || row.attempts >= MAX_ATTEMPTS) throw wrong;
    const match = timingSafeEqual(Buffer.from(row.codeHash, 'hex'), this.hash(userId, purpose, code));
    if (!match) {
      await this.prisma.emailCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw wrong;
    }
    // شرط `consumedAt: null` يمنع استعمال الرمز مرتين في طلبين متزامنين
    const used = await this.prisma.emailCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (used.count !== 1) throw wrong;
  }
}
