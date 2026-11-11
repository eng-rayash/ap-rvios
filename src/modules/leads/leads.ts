import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { createHash } from 'node:crypto';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly, Public } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import { PlatformAlerts } from '../notify/platform-alerts.service';
import { PublicRateLimit } from '../shop/public/rate-limit';

/** خيارات نموذج «متجر بتصميم خاص» — تُعرض في الواجهة بالأسماء نفسها. */
export const LEAD_BUDGETS = ['starter', 'growth', 'premium', 'unsure'] as const;
export const LEAD_TIMELINES = ['asap', 'month', 'quarter', 'unsure'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'] as const;

const BUDGET_AR: Record<string, string> = { starter: 'أساسي', growth: 'متوسط', premium: 'متكامل', unsure: 'غير محدد' };
const TIMELINE_AR: Record<string, string> = { asap: 'بأسرع وقت', month: 'خلال شهر', quarter: 'خلال ٣ أشهر', unsure: 'غير محدد' };

export class CustomStoreLeadDto {
  @IsString() @Length(2, 80) name!: string;
  /** دولي بلا «+»: 967777123456 */
  @IsString() @Matches(/^\+?[\d\s-]{8,20}$/, { message: 'رقم واتساب غير صالح' }) phone!: string;
  @IsOptional() @ValidateIf((o) => o.email !== '') @IsEmail({}, { message: 'بريد غير صالح' }) @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(40) country?: string;
  @IsOptional() @IsString() @MaxLength(80) business?: string;
  @IsOptional() @IsString() @MaxLength(80) storeName?: string;
  @IsOptional() @IsIn(LEAD_BUDGETS) budget?: string;
  @IsOptional() @IsIn(LEAD_TIMELINES) timeline?: string;
  /** الصفحات والمزايا المختارة */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) features?: string[];
  /** أسلوب التصميم: minimal · luxury · bold · playful */
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(40, { each: true }) styles?: string[];
  /** روابط متاجر أو حسابات يحبها كمثال */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(300, { each: true }) references?: string[];
  @IsOptional() @IsString() @MaxLength(80) existing?: string;
  @IsOptional() @IsString() @MaxLength(3000) message?: string;
  /** فخ للروبوتات: حقل مخفي يملؤه السكربت فقط */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsIn(LEAD_STATUSES) status?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class LeadQuery {
  @IsOptional() @IsIn([...LEAD_STATUSES, 'open', 'all']) status?: string;
  @IsOptional() @Type(() => Number) page?: number;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly alerts: PlatformAlerts,
    private readonly rate: PublicRateLimit,
  ) {}

  static ipHash(ip: string): string {
    const salt = process.env.VISIT_SALT ?? 'dev-visit-salt';
    return createHash('sha256').update(`lead:${salt}:${ip}`).digest('hex').slice(0, 32);
  }

  async customStore(dto: CustomStoreLeadDto, ip: string) {
    // الروبوت يُجاب بنجاح صامت — لا نعلّمه أن الفخ كشفه
    if (dto.website) return { ok: true };
    const ipHash = LeadsService.ipHash(ip || 'unknown');
    this.rate.check(`lead:${ipHash}`, 3, 10 * 60_000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const mine = await this.prisma.platformLead.count({ where: { ipHash, createdAt: { gte: today } } });
    if (mine >= 6) throw new HttpException({ code: 'LEAD_LIMIT', message: 'استلمنا طلباتك اليوم — راسلنا على واتساب ونكمل معك.' }, HttpStatus.TOO_MANY_REQUESTS);

    const phone = dto.phone.replace(/\D/g, '');
    const lead = await this.prisma.platformLead.create({
      data: {
        kind: 'custom_store',
        name: dto.name.trim(),
        phone,
        email: (dto.email ?? '').trim(),
        country: (dto.country ?? '').trim(),
        business: (dto.business ?? '').trim(),
        budget: dto.budget ?? '',
        timeline: dto.timeline ?? '',
        message: (dto.message ?? '').trim(),
        ipHash,
        details: {
          storeName: (dto.storeName ?? '').trim(),
          features: dto.features ?? [],
          styles: dto.styles ?? [],
          references: (dto.references ?? []).map((r) => r.trim()).filter(Boolean),
          existing: (dto.existing ?? '').trim(),
        } as Prisma.InputJsonValue,
      },
    });

    void this.alerts.raise({
      kind: 'custom_store',
      title: `طلب متجر بتصميم خاص — ${lead.name}`,
      body: [
        dto.storeName ? `المتجر: ${dto.storeName}` : '',
        lead.business ? `النشاط: ${lead.business}` : '',
        `واتساب: +${phone}`,
        lead.budget ? `الميزانية: ${BUDGET_AR[lead.budget] ?? lead.budget}` : '',
        lead.timeline ? `الموعد: ${TIMELINE_AR[lead.timeline] ?? lead.timeline}` : '',
        dto.features?.length ? `المزايا: ${dto.features.join('، ')}` : '',
      ].filter(Boolean).join('\n'),
      link: `/platform/leads?id=${lead.id}`,
      data: { leadId: lead.id },
    });
    return { ok: true, id: lead.id };
  }

  async list(q: LeadQuery) {
    const take = 30;
    const page = Math.max(1, q.page ?? 1);
    const where: Prisma.PlatformLeadWhereInput =
      !q.status || q.status === 'open' ? { status: { in: ['new', 'contacted', 'quoted'] } } : q.status === 'all' ? {} : { status: q.status };
    const [items, total, counts] = await Promise.all([
      this.prisma.platformLead.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
      this.prisma.platformLead.count({ where }),
      this.prisma.platformLead.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      items: items.map(({ ipHash: _ip, ...l }) => l),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / take)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  async get(id: string) {
    const l = await this.prisma.platformLead.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('الطلب غير موجود');
    const { ipHash: _ip, ...rest } = l;
    return rest;
  }

  async update(id: string, dto: UpdateLeadDto, userId: string) {
    await this.get(id);
    const l = await this.prisma.platformLead.update({
      where: { id },
      data: { ...(dto.status ? { status: dto.status } : {}), ...(dto.notes !== undefined ? { notes: dto.notes } : {}), handledBy: userId },
    });
    const { ipHash: _ip, ...rest } = l;
    return rest;
  }
}

/** نموذج «متجر بتصميم خاص» في منصة المتاجر — بلا حساب. */
@Public()
@Controller('shop/public')
export class PublicLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Post('custom-store')
  customStore(@Body() dto: CustomStoreLeadDto, @Ip() ip: string) {
    return this.leads.customStore(dto, ip);
  }
}

/** متابعة طلبات التصميم الخاص من لوحة المنصة وتطبيق RVOS. */
@PlatformOnly()
@Controller('platform/leads')
export class PlatformLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@Platform() _ctx: PlatformContext, @Query() q: LeadQuery) {
    return this.leads.list(q);
  }

  @Get(':id')
  get(@Platform() _ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(id);
  }

  @Patch(':id')
  update(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLeadDto) {
    return this.leads.update(id, dto, ctx.userId);
  }
}
