import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService, tenantCreate } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { NotificationKind } from './work.constants';
import { PeopleService } from './people.service';

const PAGE = 30;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly people: PeopleService,
  ) {}

  /** ينشئ إشعارًا لمستخدم — لا شيء لمن يفعل الفعل بنفسه. */
  async notify(
    ctx: TenantContext,
    to: string | null | undefined,
    n: { kind: NotificationKind; title: string; body?: string; link?: string },
  ) {
    if (!to || to === ctx.userId) return;
    await this.prisma.forTenant(ctx.companyId).notification.create({
      data: tenantCreate<Prisma.NotificationUncheckedCreateInput>({
        userId: to,
        kind: n.kind,
        title: n.title,
        body: n.body ?? '',
        link: n.link ?? null,
        actorId: ctx.userId,
      }),
    });
  }

  /** إشعاراتي فقط، الأحدث أولًا. `unread` يعدّ غير المقروء كله لا الصفحة. */
  async list(ctx: TenantContext, opts: { unreadOnly?: boolean; page?: number }) {
    const db = this.prisma.forTenant(ctx.companyId);
    const where: Prisma.NotificationWhereInput = {
      userId: ctx.userId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
    };
    const page = Math.max(1, opts.page ?? 1);
    const [rows, total, unread] = await Promise.all([
      db.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
      db.notification.count({ where }),
      db.notification.count({ where: { userId: ctx.userId, readAt: null } }),
    ]);
    const actors = await this.people.byIds(ctx.companyId, rows.map((r) => r.actorId));
    return {
      notifications: rows.map((r) => ({ ...r, actor: r.actorId ? actors.get(r.actorId) ?? null : null })),
      total,
      unread,
      pages: Math.max(1, Math.ceil(total / PAGE)),
    };
  }

  async unreadCount(ctx: TenantContext) {
    return {
      unread: await this.prisma
        .forTenant(ctx.companyId)
        .notification.count({ where: { userId: ctx.userId, readAt: null } }),
    };
  }

  async markRead(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const { count } = await db.notification.updateMany({
      where: { id, userId: ctx.userId },
      data: { readAt: new Date() },
    });
    if (!count) throw new NotFoundException('الإشعار غير موجود');
    return { ok: true };
  }

  async markAllRead(ctx: TenantContext) {
    const { count } = await this.prisma
      .forTenant(ctx.companyId)
      .notification.updateMany({
        where: { userId: ctx.userId, readAt: null },
        data: { readAt: new Date() },
      });
    return { updated: count };
  }

  async remove(ctx: TenantContext, id: string) {
    const { count } = await this.prisma
      .forTenant(ctx.companyId)
      .notification.deleteMany({ where: { id, userId: ctx.userId } });
    if (!count) throw new NotFoundException('الإشعار غير موجود');
    return { ok: true };
  }
}
