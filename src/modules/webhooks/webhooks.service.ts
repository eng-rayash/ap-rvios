import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, ShopOrder, ShopOrderItem, ShopStore } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { ORDER_LABEL, OrderStatus, symbolOf } from '../shop/shop.constants';
import { assertDeliverableUrl } from './url-guard';
import {
  CLAIM_LEASE_MS,
  DELIVERY_RETENTION_DAYS,
  DELIVERY_TIMEOUT_MS,
  DISABLE_AFTER_FAILURES,
  DeliveryStatus,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_SECONDS,
  WEBHOOK_EVENTS,
  WebhookEvent,
} from './webhooks.constants';
import { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto';

const SWEEP_EVERY_MS = 15_000;
const SWEEP_BATCH = 20;

const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

/** توقيع بنمط `t=<ثوانٍ>,v1=<hmac>` على `${t}.${body}` — الطابع الزمني داخل التوقيع يمنع إعادة تشغيل إرسال قديم. */
export function signPayload(secret: string, body: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

type OrderWithItems = ShopOrder & { items: ShopOrderItem[] };

/** شكل الطلب في حمولة الخطاف — قائمة بيضاء صريحة لا الصف الخام. */
export function orderPayload(o: OrderWithItems, store: Pick<ShopStore, 'id' | 'slug' | 'name' | 'country'>) {
  return {
    id: o.id,
    ref: o.ref,
    store: { id: store.id, slug: store.slug, name: store.name },
    status: o.status,
    statusLabel: ORDER_LABEL[o.status as OrderStatus] ?? '',
    payMethod: o.payMethod,
    payStatus: o.payStatus,
    customer: { name: o.custName, phone: o.custPhone, address: o.custAddress },
    zone: o.zoneName,
    note: o.note,
    currency: symbolOf(store.country),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    items: o.items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      name: i.name,
      variant: i.variant,
      price: i.price,
      qty: i.qty,
    })),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/**
 * خطافات الويب: إدارة النقاط، وتسجيل الأحداث، وإرسالها موقَّعة مع إعادة
 * المحاولة.
 *
 * الإرسال لا يُعطِّل أبدًا العملية التي ولّدت الحدث: `emit` لا يرمي، والإرسال
 * نفسه يجري بعد ردّ الطلب. عامل دوري يلتقط ما فشل ويعيد حسب
 * [RETRY_BACKOFF_SECONDS]، و«الحجز» الذرّي عند الالتقاط يمنع إرسالًا مزدوجًا
 * حتى مع أكثر من نسخة خادم.
 */
@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhooksService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private lastPrune = 0;

  constructor(private readonly prisma: TenantPrismaService) {}

  onModuleInit() {
    if (process.env.WEBHOOK_WORKER === '0') return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ═══ الإدارة ════════════════════════════════════════════

  events() {
    return WEBHOOK_EVENTS;
  }

  private view(h: { secret: string } & Record<string, unknown>) {
    const { secret, ...rest } = h;
    return { ...rest, secretHint: `whsec_…${secret.slice(-4)}` };
  }

  async list(ctx: TenantContext) {
    const rows = await this.prisma.forTenant(ctx.companyId).webhook.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((h) => this.view(h));
  }

  private async find(ctx: TenantContext, id: string) {
    const h = await this.prisma.forTenant(ctx.companyId).webhook.findFirst({ where: { id } });
    if (!h) throw new NotFoundException('نقطة النهاية غير موجودة');
    return h;
  }

  /** ينشئ نقطة ويعيد سرّ التوقيع كاملًا — يظهر هنا وعند التدوير فقط. */
  async create(ctx: TenantContext, dto: CreateWebhookDto) {
    const url = await assertDeliverableUrl(dto.url.trim());
    const secret = newSecret();
    const h = await this.prisma.forTenant(ctx.companyId).webhook.create({
      data: tenantCreate<Prisma.WebhookUncheckedCreateInput>({
        url: url.toString(),
        events: [...new Set(dto.events)],
        secret,
        createdBy: ctx.userId,
      }),
    });
    return { ...this.view(h), secret };
  }

  async update(ctx: TenantContext, id: string, dto: UpdateWebhookDto) {
    const current = await this.find(ctx, id);
    const url = dto.url !== undefined ? (await assertDeliverableUrl(dto.url.trim())).toString() : undefined;
    const reactivating = dto.isActive === true && !current.isActive;
    const h = await this.prisma.forTenant(ctx.companyId).webhook.update({
      where: { id },
      data: {
        ...(url !== undefined && { url }),
        ...(dto.events !== undefined && { events: [...new Set(dto.events)] }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        // إعادة التفعيل تعني «أصلحتُ المستقبِل» — يبدأ العدّ من جديد
        ...(reactivating && { failureCount: 0 }),
      },
    });
    return this.view(h);
  }

  async remove(ctx: TenantContext, id: string) {
    await this.find(ctx, id);
    await this.prisma.forTenant(ctx.companyId).webhook.delete({ where: { id } });
    return { ok: true };
  }

  async rotateSecret(ctx: TenantContext, id: string) {
    await this.find(ctx, id);
    const secret = newSecret();
    const h = await this.prisma.forTenant(ctx.companyId).webhook.update({
      where: { id },
      data: { secret },
    });
    return { ...this.view(h), secret };
  }

  async deliveries(ctx: TenantContext, id: string) {
    await this.find(ctx, id);
    return this.prisma.forTenant(ctx.companyId).webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  /** حدث تجريبي لهذه النقطة وحدها — يُنتظر ليرى التاجر النتيجة فورًا. */
  async sendTest(ctx: TenantContext, id: string) {
    const h = await this.find(ctx, id);
    const d = await this.enqueue(ctx.companyId, h.id, 'webhook.test', {
      message: 'هذا حدث تجريبي من عزم سمارت',
      webhookId: h.id,
    });
    await this.attempt(d.id);
    return this.prisma.forTenant(ctx.companyId).webhookDelivery.findFirst({ where: { id: d.id } });
  }

  /** إعادة إرسال: صف جديد بالحمولة نفسها، فيبقى السجل الأصلي كما هو. */
  async redeliver(ctx: TenantContext, deliveryId: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const old = await db.webhookDelivery.findFirst({ where: { id: deliveryId } });
    if (!old) throw new NotFoundException('الإرسال غير موجود');
    const payload = old.payload as { data?: unknown };
    const d = await this.enqueue(ctx.companyId, old.webhookId, old.event, payload.data ?? null);
    await this.attempt(d.id);
    return db.webhookDelivery.findFirst({ where: { id: d.id } });
  }

  // ═══ الأحداث ═══════════════════════════════════════════

  private enqueue(companyId: string, webhookId: string, event: string, data: unknown) {
    return this.prisma.forTenant(companyId).webhookDelivery.create({
      data: tenantCreate<Prisma.WebhookDeliveryUncheckedCreateInput>({
        webhookId,
        event,
        payload: { event, createdAt: new Date().toISOString(), data } as Prisma.InputJsonValue,
        nextAttemptAt: new Date(),
      }),
    });
  }

  /**
   * يسجّل حدثًا لكل نقطة فعّالة مشتركة فيه، ثم يبدأ الإرسال دون انتظار.
   * **لا يرمي أبدًا** — فشل الخطافات لا يُسقط طلبًا ولا تغيير حالة.
   */
  async emit(companyId: string, event: WebhookEvent, data: unknown): Promise<void> {
    try {
      const hooks = await this.prisma.forTenant(companyId).webhook.findMany({
        where: { isActive: true, events: { has: event } },
        select: { id: true },
      });
      for (const h of hooks) {
        const d = await this.enqueue(companyId, h.id, event, data);
        void this.attempt(d.id).catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`تعذّر تسجيل الحدث ${event}: ${(err as Error).message}`);
    }
  }

  // ═══ الإرسال ═══════════════════════════════════════════

  /** يلتقط الإرسالات المستحقة ويعيد محاولتها — العميل الأساس عمدًا (عبر كل الشركات). */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.prisma.webhookDelivery.findMany({
        where: { status: DeliveryStatus.Pending, nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: SWEEP_BATCH,
        select: { id: true },
      });
      for (const d of due) await this.attempt(d.id);

      if (Date.now() - this.lastPrune > 3_600_000) {
        this.lastPrune = Date.now();
        await this.prisma.webhookDelivery.deleteMany({
          where: { createdAt: { lt: new Date(Date.now() - DELIVERY_RETENTION_DAYS * 86_400_000) } },
        });
      }
    } catch (err) {
      this.logger.warn(`تعذّر مسح الخطافات: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** محاولة إرسال واحدة. آمنة للاستدعاء المتزامن: الحجز الذرّي يجعل عاملًا واحدًا فقط يرسل. */
  async attempt(deliveryId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: DeliveryStatus.Pending, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (!claimed.count) return;

    const d = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    });
    if (!d) return;

    if (!d.webhook.isActive) {
      await this.prisma.webhookDelivery.update({
        where: { id: d.id },
        data: { status: DeliveryStatus.Failed, error: 'نقطة النهاية معطّلة', nextAttemptAt: null },
      });
      return;
    }

    const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
    const t = Math.floor(Date.now() / 1000);
    let code: number | null = null;
    let error: string | null = null;
    let ok = false;

    try {
      const url = await assertDeliverableUrl(d.webhook.url);
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AzmSmart-Webhooks/1.0',
          'X-Azm-Event': d.event,
          'X-Azm-Delivery': d.id,
          'X-Azm-Signature': signPayload(d.webhook.secret, body, t),
        },
        body,
      });
      code = res.status;
      ok = res.status >= 200 && res.status < 300;
      if (!ok) error = `ردّ المستقبِل ${res.status}`;
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      const e = err as Error & { getResponse?: () => { message?: string } };
      error =
        e.getResponse?.().message ??
        (e.name === 'TimeoutError' ? `لم يردّ خلال ${DELIVERY_TIMEOUT_MS / 1000} ثوانٍ` : e.message);
    }

    const attempts = d.attempts + 1;

    if (ok) {
      await this.prisma.$transaction([
        this.prisma.webhookDelivery.update({
          where: { id: d.id },
          data: {
            status: DeliveryStatus.Succeeded,
            attempts,
            responseCode: code,
            error: null,
            deliveredAt: new Date(),
            nextAttemptAt: null,
          },
        }),
        this.prisma.webhook.update({
          where: { id: d.webhookId },
          data: { failureCount: 0, lastDeliveryAt: new Date(), lastStatus: code },
        }),
      ]);
      return;
    }

    const final = attempts >= MAX_ATTEMPTS;
    const failures = d.webhook.failureCount + 1;
    await this.prisma.$transaction([
      this.prisma.webhookDelivery.update({
        where: { id: d.id },
        data: {
          status: final ? DeliveryStatus.Failed : DeliveryStatus.Pending,
          attempts,
          responseCode: code,
          error: error?.slice(0, 300) ?? null,
          nextAttemptAt: final
            ? null
            : new Date(Date.now() + RETRY_BACKOFF_SECONDS[attempts - 1] * 1000),
        },
      }),
      this.prisma.webhook.update({
        where: { id: d.webhookId },
        data: {
          failureCount: failures,
          lastDeliveryAt: new Date(),
          lastStatus: code ?? 0,
          // مستقبِل ميت منذ مدة: نتوقف عن طرقه حتى يعيد التاجر تفعيله
          ...(failures >= DISABLE_AFTER_FAILURES && { isActive: false }),
        },
      }),
    ]);
  }
}
