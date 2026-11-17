import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { randomBytes } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly, RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { PlatformContext, TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { PlatformAlerts } from '../notify/platform-alerts.service';
import { PushService } from '../notify/push.service';

/** 0 مفتوحة (بانتظار الفريق) · 1 رُدّ عليها (بانتظار التاجر) · 2 مغلقة */
export enum TicketStatus {
  Open = 0,
  Answered = 1,
  Closed = 2,
}
export const TICKET_CATEGORIES = ['store', 'billing', 'technical', 'domain', 'other'] as const;

export class CreateTicketDto {
  @IsString() @Length(4, 120) subject!: string;
  @IsIn(TICKET_CATEGORIES) category!: string;
  /** 0 عادية · 1 مهمة · 2 عاجلة (المتجر متوقف) */
  @IsOptional() @IsInt() @Min(0) @Max(2) priority?: number;
  @IsString() @Length(10, 4000) body!: string;
  @IsOptional() @IsUUID() storeId?: string;
}
export class TicketMessageDto {
  @IsString() @Length(1, 4000) body!: string;
}
export class TicketStatusDto {
  @IsInt() @IsIn([0, 1, 2]) status!: number;
}

const ref = () => `T-${randomBytes(3).toString('hex').toUpperCase()}`;

/**
 * تذاكر الدعم بين التاجر وفريق المنصة — محادثة لكل مشكلة بحالة واضحة: من ينتظر من.
 * التاجر يرى تذاكر شركته فقط، والفريق يرى الكل ويُنبَّه بكل تذكرة ورد.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly alerts: PlatformAlerts,
    private readonly push: PushService,
  ) {}

  // ═══ التاجر ═══════════════════════════════════════════════

  list(ctx: TenantContext) {
    return this.prisma.forTenant(ctx.companyId).supportTicket.findMany({
      where: {},
      orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
      take: 100,
      include: { store: { select: { name: true } }, _count: { select: { messages: true } } },
    });
  }

  async create(ctx: TenantContext, dto: CreateTicketDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    if ((await db.supportTicket.count({ where: { status: { not: TicketStatus.Closed } } })) >= 10) {
      throw new BadRequestException('لديك ١٠ تذاكر مفتوحة — أكمل إحداها أو أغلقها أولًا');
    }
    if (dto.storeId && !(await db.shopStore.findFirst({ where: { id: dto.storeId }, select: { id: true } }))) {
      throw new NotFoundException('المتجر غير موجود');
    }
    const t = await db.supportTicket.create({
      data: {
        companyId: ctx.companyId, storeId: dto.storeId ?? null, ref: ref(), subject: dto.subject.trim(), category: dto.category,
        priority: dto.priority ?? 0, createdById: ctx.userId,
        messages: { create: { companyId: ctx.companyId, authorId: ctx.userId, fromStaff: false, body: dto.body.trim() } },
      },
    });
    const company = await this.prisma.organization.findUnique({ where: { id: ctx.companyId }, select: { name: true } });
    void this.alerts.raise({
      kind: 'support',
      title: `${dto.priority === 2 ? '🔴 عاجلة: ' : ''}تذكرة ${t.ref} — ${t.subject}`,
      body: `${company?.name ?? ''}: ${dto.body.trim().slice(0, 300)}`,
      link: `/platform/support?t=${t.id}`,
      data: { ticketId: t.id },
    });
    return t;
  }

  private async mine(ctx: TenantContext, id: string) {
    const t = await this.prisma.forTenant(ctx.companyId).supportTicket.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('التذكرة غير موجودة');
    return t;
  }

  async get(ctx: TenantContext, id: string) {
    await this.mine(ctx, id);
    return this.withMessages(id);
  }

  async reply(ctx: TenantContext, id: string, dto: TicketMessageDto) {
    const t = await this.mine(ctx, id);
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: id, companyId: t.companyId, authorId: ctx.userId, fromStaff: false, body: dto.body.trim() } }),
      // ردّ التاجر يعيد التذكرة (حتى المغلقة) إلى الفريق
      this.prisma.supportTicket.update({ where: { id }, data: { status: TicketStatus.Open, lastMessageAt: new Date() } }),
    ]);
    void this.alerts.raise({ kind: 'support', title: `ردّ على ${t.ref} — ${t.subject}`, body: dto.body.trim().slice(0, 300), link: `/platform/support?t=${id}`, data: { ticketId: id } });
    return this.withMessages(id);
  }

  async close(ctx: TenantContext, id: string) {
    await this.mine(ctx, id);
    await this.prisma.supportTicket.update({ where: { id }, data: { status: TicketStatus.Closed } });
    return this.withMessages(id);
  }

  private withMessages(id: string) {
    return this.prisma.supportTicket.findUnique({
      where: { id },
      include: {
        store: { select: { name: true, slug: true } },
        organization: { select: { name: true } },
        messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { displayName: true } } } },
      },
    });
  }

  // ═══ فريق المنصة ═══════════════════════════════════════════

  async platformList(status?: number) {
    const [tickets, counts] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where: status !== undefined ? { status } : {},
        orderBy: [{ priority: 'desc' }, { lastMessageAt: 'asc' }],
        take: 200,
        include: { organization: { select: { name: true } }, store: { select: { name: true, slug: true } }, _count: { select: { messages: true } } },
      }),
      this.prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return { tickets, counts: { 0: 0, 1: 0, 2: 0, ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])) } as Record<number, number> };
  }

  async platformGet(id: string) {
    const t = await this.withMessages(id);
    if (!t) throw new NotFoundException('التذكرة غير موجودة');
    return t;
  }

  async platformReply(p: PlatformContext, id: string, dto: TicketMessageDto) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('التذكرة غير موجودة');
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: id, companyId: t.companyId, authorId: p.userId, fromStaff: true, body: dto.body.trim() } }),
      this.prisma.supportTicket.update({ where: { id }, data: { status: TicketStatus.Answered, lastMessageAt: new Date() } }),
    ]);
    void this.push.toCompany(t.companyId, {
      title: `ردّ فريق RVIOS على ${t.ref}`,
      body: dto.body.trim().slice(0, 140),
      link: `/support?t=${id}`,
      kind: 'support',
      data: { ticketId: id },
    }).catch(() => undefined);
    return this.withMessages(id);
  }

  async platformStatus(id: string, status: number) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('التذكرة غير موجودة');
    await this.prisma.supportTicket.update({ where: { id }, data: { status } });
    return this.withMessages(id);
  }
}

@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Tenant() ctx: TenantContext) {
    return this.support.list(ctx);
  }

  @RequireRole(UserRole.Employee)
  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateTicketDto) {
    return this.support.create(ctx, dto);
  }

  @Get(':id')
  get(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(ctx, id);
  }

  @RequireRole(UserRole.Employee)
  @Post(':id/messages')
  reply(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketMessageDto) {
    return this.support.reply(ctx, id, dto);
  }

  @RequireRole(UserRole.Employee)
  @Post(':id/close')
  close(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.close(ctx, id);
  }
}

@PlatformOnly()
@Controller('platform/support')
export class PlatformSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Platform() _p: PlatformContext, @Query('status') status?: string) {
    const s = status !== undefined && status !== '' ? Number(status) : undefined;
    return this.support.platformList(Number.isInteger(s) ? s : undefined);
  }

  @Get(':id')
  get(@Platform() _p: PlatformContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.platformGet(id);
  }

  @Post(':id/messages')
  reply(@Platform() p: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketMessageDto) {
    return this.support.platformReply(p, id, dto);
  }

  @Patch(':id')
  status(@Platform() _p: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketStatusDto) {
    return this.support.platformStatus(id, dto.status);
  }
}
