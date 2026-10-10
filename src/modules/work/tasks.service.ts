import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService, tenantCreate } from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { ActivityService } from './activity.service';
import { NotificationsService } from './notifications.service';
import { PeopleService } from './people.service';
import { TASK_STATUS_LABEL, TaskStatus } from './work.constants';
import { CommentDto, CreateTaskDto, UpdateTaskDto } from './work.dto';

const d = (v?: string) => (v ? new Date(v) : undefined);

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly people: PeopleService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  private async hydrate(ctx: TenantContext, rows: Prisma.WorkTaskGetPayload<{ include: { project: { select: { key: true; name: true; color: true } }; _count: { select: { comments: true } } } }>[]) {
    const who = await this.people.byIds(ctx.companyId, rows.flatMap((r) => [r.assigneeId, r.createdBy]));
    return rows.map(({ project, _count, ...t }) => ({
      ...t,
      code: `${project.key}-${t.number}`,
      project,
      assignee: t.assigneeId ? who.get(t.assigneeId) ?? null : null,
      comments: _count.comments,
    }));
  }

  private readonly include = {
    project: { select: { key: true, name: true, color: true } },
    _count: { select: { comments: true } },
  } as const;

  async list(
    ctx: TenantContext,
    f: { projectId?: string; assignee?: string; status?: number; q?: string },
  ) {
    const where: Prisma.WorkTaskWhereInput = {
      ...(f.projectId ? { projectId: f.projectId } : {}),
      ...(f.assignee === 'me' ? { assigneeId: ctx.userId } : f.assignee ? { assigneeId: f.assignee } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.q ? { title: { contains: f.q, mode: 'insensitive' } } : {}),
    };
    const rows = await this.prisma.forTenant(ctx.companyId).workTask.findMany({
      where,
      include: this.include,
      orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return { tasks: await this.hydrate(ctx, rows) };
  }

  async get(ctx: TenantContext, id: string) {
    const row = await this.prisma.forTenant(ctx.companyId).workTask.findFirst({
      where: { id },
      include: this.include,
    });
    if (!row) throw new NotFoundException('المهمة غير موجودة');
    return (await this.hydrate(ctx, [row]))[0];
  }

  async create(ctx: TenantContext, dto: CreateTaskDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const project = await db.workProject.findFirst({ where: { id: dto.projectId } });
    if (!project) throw new NotFoundException('المشروع غير موجود');
    await this.people.assertMembers(ctx.companyId, [dto.assigneeId]);

    const status = dto.status ?? TaskStatus.Todo;
    // رقم متسلسل داخل المشروع — زيادة ذرّية تمنع رقمين متطابقين عند طلبين متزامنين
    const { taskSeq } = await db.workProject.update({
      where: { id: project.id },
      data: { taskSeq: { increment: 1 } },
      select: { taskSeq: true },
    });
    const last = await db.workTask.aggregate({
      where: { projectId: project.id, status },
      _max: { position: true },
    });

    const task = await db.workTask.create({
      data: tenantCreate<Prisma.WorkTaskUncheckedCreateInput>({
        projectId: project.id,
        number: taskSeq,
        title: dto.title.trim(),
        description: dto.description ?? '',
        status,
        priority: dto.priority ?? 1,
        assigneeId: dto.assigneeId ?? null,
        labels: dto.labels ?? [],
        startDate: d(dto.startDate),
        dueDate: d(dto.dueDate),
        points: dto.points ?? 0,
        position: (last._max.position ?? -1) + 1,
        createdBy: ctx.userId,
        completedAt: status === TaskStatus.Done ? new Date() : null,
      }),
    });
    await this.notifications.notify(ctx, task.assigneeId, {
      kind: 'assign',
      title: 'مهمة جديدة موكلة إليك',
      body: `${project.key}-${task.number} · ${task.title}`,
      link: `/projects/${project.id}`,
    });
    await this.activity.log(ctx, 'task.created', { type: 'task', id: task.id }, `أنشأ المهمة ${project.key}-${task.number} «${task.title}»`, project.id);
    return this.get(ctx, task.id);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateTaskDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const cur = await this.get(ctx, id);
    if (dto.assigneeId) await this.people.assertMembers(ctx.companyId, [dto.assigneeId]);

    const becameDone = dto.status === TaskStatus.Done && cur.status !== TaskStatus.Done;
    const reopened = dto.status !== undefined && dto.status !== TaskStatus.Done && cur.status === TaskStatus.Done;

    await db.workTask.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.assigneeId !== undefined && { assigneeId: dto.assigneeId }),
        ...(dto.labels !== undefined && { labels: dto.labels }),
        ...(dto.startDate !== undefined && { startDate: d(dto.startDate) }),
        ...(dto.dueDate !== undefined && { dueDate: d(dto.dueDate) }),
        ...(dto.points !== undefined && { points: dto.points }),
        ...(dto.position !== undefined && { position: dto.position }),
        ...(becameDone && { completedAt: new Date() }),
        ...(reopened && { completedAt: null }),
      },
    });

    if (dto.assigneeId && dto.assigneeId !== cur.assigneeId) {
      await this.activity.log(ctx, 'task.assigned', { type: 'task', id }, `أسند ${cur.code} «${cur.title}»`, cur.projectId);
      await this.notifications.notify(ctx, dto.assigneeId, {
        kind: 'assign',
        title: 'مهمة جديدة موكلة إليك',
        body: `${cur.code} · ${cur.title}`,
        link: `/projects/${cur.projectId}`,
      });
    }
    if (dto.status !== undefined && dto.status !== cur.status) {
      await this.activity.log(ctx, 'task.status', { type: 'task', id }, `نقل ${cur.code} «${cur.title}» إلى «${TASK_STATUS_LABEL[dto.status]}»`, cur.projectId);
      if (becameDone) await this.notifications.notify(ctx, cur.createdBy, { kind: 'system', title: 'اكتملت مهمة', body: `${cur.code} · ${cur.title}`, link: `/projects/${cur.projectId}` });
    }
    return this.get(ctx, id);
  }

  async remove(ctx: TenantContext, id: string) {
    const cur = await this.get(ctx, id);
    await this.prisma.forTenant(ctx.companyId).workTask.delete({ where: { id } });
    await this.activity.log(ctx, 'task.deleted', { type: 'task', id }, `حذف المهمة ${cur.code} «${cur.title}»`, cur.projectId);
    return { ok: true };
  }

  // ── التعليقات ──
  async comments(ctx: TenantContext, taskId: string) {
    await this.get(ctx, taskId);
    const rows = await this.prisma.forTenant(ctx.companyId).workTaskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const who = await this.people.byIds(ctx.companyId, rows.map((r) => r.authorId));
    return { comments: rows.map((r) => ({ ...r, author: who.get(r.authorId) ?? null })) };
  }

  async comment(ctx: TenantContext, taskId: string, dto: CommentDto) {
    const task = await this.get(ctx, taskId);
    const c = await this.prisma.forTenant(ctx.companyId).workTaskComment.create({
      data: tenantCreate<Prisma.WorkTaskCommentUncheckedCreateInput>({
        taskId,
        authorId: ctx.userId,
        body: dto.body.trim(),
      }),
    });
    for (const to of new Set([task.assigneeId, task.createdBy])) {
      await this.notifications.notify(ctx, to, {
        kind: 'comment',
        title: 'تعليق جديد',
        body: `${task.code} · ${dto.body.trim().slice(0, 120)}`,
        link: `/projects/${task.projectId}`,
      });
    }
    await this.activity.log(ctx, 'task.commented', { type: 'task', id: taskId }, `علّق على ${task.code} «${task.title}»`, task.projectId);
    const who = await this.people.byIds(ctx.companyId, [ctx.userId]);
    return { ...c, author: who.get(ctx.userId) ?? null };
  }
}
