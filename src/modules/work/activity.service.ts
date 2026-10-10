import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { PeopleService } from './people.service';

const PAGE = 40;

/**
 * سجل النشاط — يُكتب في `AuditLog` نفسه الذي يخدم التدقيق، فلا جدول ثانٍ.
 * الفعل بنمط `<كيان>.<فعل>` (`task.created`, `project.updated` …).
 * فشل التسجيل لا يُسقط العملية الأصلية.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly people: PeopleService,
  ) {}

  async log(
    ctx: TenantContext,
    action: string,
    entity: { type: string; id: string },
    description: string,
    projectId?: string,
  ) {
    try {
      await this.prisma.forTenant(ctx.companyId).auditLog.create({
        data: tenantCreate<Prisma.AuditLogUncheckedCreateInput>({
          syncId: randomUUID(),
          actorId: ctx.userId,
          action,
          entityType: entity.type,
          entityId: entity.id,
          description,
          // يربط الحدث بمشروعه ليُعرض في نشاط المشروع (ويُفلتر عليه)
          ...(projectId ? { newValue: { projectId } } : {}),
        }),
      });
    } catch {
      /* سجل النشاط مساعد — لا يُفشل العملية */
    }
  }

  async list(ctx: TenantContext, opts: { page?: number; entityType?: string; actorId?: string; projectId?: string }) {
    const db = this.prisma.forTenant(ctx.companyId);
    const where: Prisma.AuditLogWhereInput = {
      ...(opts.entityType ? { entityType: opts.entityType } : {}),
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(opts.projectId ? { newValue: { path: ['projectId'], equals: opts.projectId } } : {}),
    };
    const page = Math.max(1, opts.page ?? 1);
    const [rows, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          description: true,
          actorId: true,
          createdAt: true,
        },
      }),
      db.auditLog.count({ where }),
    ]);
    const actors = await this.people.byIds(ctx.companyId, rows.map((r) => r.actorId));
    return {
      activity: rows.map((r) => ({ ...r, actor: r.actorId ? actors.get(r.actorId) ?? null : null })),
      total,
      pages: Math.max(1, Math.ceil(total / PAGE)),
    };
  }
}
