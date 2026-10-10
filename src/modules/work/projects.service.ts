import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService, tenantCreate } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { ActivityService } from './activity.service';
import { NotificationsService } from './notifications.service';
import { PeopleService, Person } from './people.service';
import { ProjectStatus, TaskStatus } from './work.constants';
import { CreateProjectDto, MilestoneDto, UpdateMilestoneDto, UpdateProjectDto } from './work.dto';

type ProjectRow = Prisma.WorkProjectGetPayload<{ include: { members: true; milestones: true } }>;

const d = (v?: string) => (v ? new Date(v) : undefined);

@Injectable()
export class WorkProjectsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly people: PeopleService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /** الواجهة تُعرض بما يحتاجه القالب: تقدّم محسوب وأشخاص بأسمائهم. */
  private view(p: ProjectRow, who: Map<string, Person>, counts: { total: number; done: number }) {
    const progress =
      p.status === ProjectStatus.Done ? 100 : counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
    const { members, milestones, taskSeq: _seq, ...rest } = p;
    void _seq;
    return {
      ...rest,
      lead: p.leadId ? who.get(p.leadId) ?? null : null,
      members: members.map((m) => who.get(m.userId)).filter((x): x is Person => !!x),
      milestones: [...milestones]
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((m) => ({ id: m.id, title: m.title, date: m.date, done: m.done })),
      taskCounts: counts,
      progress,
    };
  }

  private async countsFor(ctx: TenantContext, projectIds: string[]) {
    const out = new Map<string, { total: number; done: number }>();
    if (!projectIds.length) return out;
    const grouped = await this.prisma.forTenant(ctx.companyId).workTask.groupBy({
      by: ['projectId', 'status'],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      const c = out.get(g.projectId) ?? { total: 0, done: 0 };
      c.total += g._count._all;
      if (g.status === TaskStatus.Done) c.done += g._count._all;
      out.set(g.projectId, c);
    }
    return out;
  }

  private async hydrate(ctx: TenantContext, rows: ProjectRow[]) {
    const who = await this.people.byIds(
      ctx.companyId,
      rows.flatMap((r) => [r.leadId, ...r.members.map((m) => m.userId)]),
    );
    const counts = await this.countsFor(ctx, rows.map((r) => r.id));
    return rows.map((r) => this.view(r, who, counts.get(r.id) ?? { total: 0, done: 0 }));
  }

  async list(ctx: TenantContext, opts: { status?: number }) {
    const rows = await this.prisma.forTenant(ctx.companyId).workProject.findMany({
      where: opts.status !== undefined ? { status: opts.status } : {},
      include: { members: true, milestones: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { projects: await this.hydrate(ctx, rows) };
  }

  async get(ctx: TenantContext, id: string) {
    const row = await this.prisma.forTenant(ctx.companyId).workProject.findFirst({
      where: { id },
      include: { members: true, milestones: true },
    });
    if (!row) throw new NotFoundException('المشروع غير موجود');
    return (await this.hydrate(ctx, [row]))[0];
  }

  async create(ctx: TenantContext, dto: CreateProjectDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const key = dto.key.toUpperCase();
    const members = [...new Set([...(dto.memberIds ?? []), ...(dto.leadId ? [dto.leadId] : [])])];
    await this.people.assertMembers(ctx.companyId, [dto.leadId, ...members]);

    if (await db.workProject.findFirst({ where: { key } })) {
      throw new ConflictException('هذا الرمز مستخدم لمشروع آخر');
    }

    const project = await db.workProject.create({
      data: tenantCreate<Prisma.WorkProjectUncheckedCreateInput>({
        key,
        name: dto.name.trim(),
        description: dto.description ?? '',
        status: dto.status ?? ProjectStatus.OnTrack,
        color: dto.color ?? 'var(--chart-1)',
        category: dto.category ?? '',
        leadId: dto.leadId ?? ctx.userId,
        startDate: d(dto.startDate),
        dueDate: d(dto.dueDate),
        budget: dto.budget ?? 0,
        spent: dto.spent ?? 0,
        createdBy: ctx.userId,
      }),
    });
    const all = [...new Set([...members, project.leadId!])];
    await db.workProjectMember.createMany({
      data: all.map((userId) => ({ companyId: ctx.companyId, projectId: project.id, userId })),
    });
    for (const u of all) {
      await this.notifications.notify(ctx, u, {
        kind: 'assign',
        title: 'أُضفتَ إلى مشروع',
        body: project.name,
        link: `/projects/${project.id}`,
      });
    }
    await this.activity.log(ctx, 'project.created', { type: 'project', id: project.id }, `أنشأ المشروع «${project.name}»`, project.id);
    return this.get(ctx, project.id);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateProjectDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.get(ctx, id);
    await this.people.assertMembers(ctx.companyId, [dto.leadId, ...(dto.memberIds ?? [])]);

    await db.workProject.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.leadId !== undefined && { leadId: dto.leadId }),
        ...(dto.startDate !== undefined && { startDate: d(dto.startDate) }),
        ...(dto.dueDate !== undefined && { dueDate: d(dto.dueDate) }),
        ...(dto.budget !== undefined && { budget: dto.budget }),
        ...(dto.spent !== undefined && { spent: dto.spent }),
      },
    });

    if (dto.memberIds) {
      const want = new Set([...dto.memberIds, ...(dto.leadId ?? current.lead?.id ? [dto.leadId ?? current.lead!.id] : [])]);
      const have = new Set(current.members.map((m) => m.id));
      await db.workProjectMember.deleteMany({ where: { projectId: id, userId: { notIn: [...want] } } });
      const added = [...want].filter((u) => !have.has(u));
      if (added.length) {
        await db.workProjectMember.createMany({
          data: added.map((userId) => ({ companyId: ctx.companyId, projectId: id, userId })),
          skipDuplicates: true,
        });
        for (const u of added) {
          await this.notifications.notify(ctx, u, {
            kind: 'assign',
            title: 'أُضفتَ إلى مشروع',
            body: current.name,
            link: `/projects/${id}`,
          });
        }
      }
    }
    await this.activity.log(ctx, 'project.updated', { type: 'project', id }, `عدّل المشروع «${current.name}»`, id);
    return this.get(ctx, id);
  }

  async remove(ctx: TenantContext, id: string) {
    const current = await this.get(ctx, id);
    // المهام والمعالم والأعضاء تُحذف بالتتالي (onDelete: Cascade)
    await this.prisma.forTenant(ctx.companyId).workProject.delete({ where: { id } });
    await this.activity.log(ctx, 'project.deleted', { type: 'project', id }, `حذف المشروع «${current.name}»`);
    return { ok: true };
  }

  // ── المعالم ──
  async addMilestone(ctx: TenantContext, projectId: string, dto: MilestoneDto) {
    await this.get(ctx, projectId);
    const m = await this.prisma.forTenant(ctx.companyId).workMilestone.create({
      data: tenantCreate<Prisma.WorkMilestoneUncheckedCreateInput>({
        projectId,
        title: dto.title.trim(),
        date: new Date(dto.date),
        done: dto.done ?? false,
      }),
    });
    return { id: m.id, title: m.title, date: m.date, done: m.done };
  }

  async updateMilestone(ctx: TenantContext, id: string, dto: UpdateMilestoneDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const cur = await db.workMilestone.findFirst({ where: { id } });
    if (!cur) throw new NotFoundException('المعلم غير موجود');
    const m = await db.workMilestone.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(dto.done !== undefined && { done: dto.done }),
      },
    });
    return { id: m.id, title: m.title, date: m.date, done: m.done };
  }

  async removeMilestone(ctx: TenantContext, id: string) {
    const { count } = await this.prisma.forTenant(ctx.companyId).workMilestone.deleteMany({ where: { id } });
    if (!count) throw new NotFoundException('المعلم غير موجود');
    return { ok: true };
  }
}
