import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import { monthStart } from './ai-usage.service';
import { KB } from './knowledge/kb';
import { KnowledgeService } from './knowledge/kb.service';

class KnowledgeDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) tags?: string[];
  @IsArray() @ArrayMinSize(1) @IsIn(['merchant', 'public'], { each: true }) audience!: ('merchant' | 'public')[];
  @IsString() @MinLength(20) @MaxLength(4000) text!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class KnowledgePatchDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) tags?: string[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(['merchant', 'public'], { each: true }) audience?: ('merchant' | 'public')[];
  @IsOptional() @IsString() @MinLength(20) @MaxLength(4000) text?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class KnowledgeTestDto {
  @IsString() @MinLength(2) @MaxLength(500) question!: string;
  @IsIn(['merchant', 'public']) audience!: 'merchant' | 'public';
}

/**
 * «تدريب» RVIOS AI من لوحة المنصة: معرفة يضيفها الفريق وتُسترجع حسب السؤال، واختبار لما
 * سيقرؤه المساعد لسؤال بعينه، وأرقام الاستهلاك والتكلفة. فريق المنصة وحده.
 */
@PlatformOnly()
@Controller('platform/ai')
export class AiAdminController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  @Get('knowledge')
  async list() {
    const rows = await this.prisma.aiKnowledge.findMany({ orderBy: { updatedAt: 'desc' }, take: 500 });
    // القاعدة المكتوبة تظهر للاطلاع فقط — تعديلها في الشيفرة
    const builtin = KB.map((c) => ({ id: c.id, title: c.title, audience: c.audience, chars: c.text.length }));
    return { entries: rows, builtin };
  }

  @Post('knowledge')
  async create(@Platform() ctx: PlatformContext, @Body() dto: KnowledgeDto) {
    const row = await this.prisma.aiKnowledge.create({
      data: { title: dto.title.trim(), tags: clean(dto.tags), audience: [...new Set(dto.audience)], text: dto.text.trim(), active: dto.active ?? true, updatedBy: ctx.userId },
    });
    this.knowledge.invalidate();
    return row;
  }

  @Patch('knowledge/:id')
  async update(@Platform() ctx: PlatformContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: KnowledgePatchDto) {
    const found = await this.prisma.aiKnowledge.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('غير موجود');
    const row = await this.prisma.aiKnowledge.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.tags !== undefined ? { tags: clean(dto.tags) } : {}),
        ...(dto.audience !== undefined ? { audience: [...new Set(dto.audience)] } : {}),
        ...(dto.text !== undefined ? { text: dto.text.trim() } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        updatedBy: ctx.userId,
      },
    });
    this.knowledge.invalidate();
    return row;
  }

  @Delete('knowledge/:id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const found = await this.prisma.aiKnowledge.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('غير موجود');
    await this.prisma.aiKnowledge.delete({ where: { id } });
    this.knowledge.invalidate();
    return { ok: true };
  }

  /** ما سيقرؤه المساعد لهذا السؤال — يختبر الفريق أثر ما أضافه قبل أن يعتمد عليه */
  @Post('knowledge/test')
  async test(@Body() dto: KnowledgeTestDto) {
    await this.knowledge.ensureFresh(true);
    return { picked: this.knowledge.search(dto.question, dto.audience, 5).map((c) => ({ id: c.id, title: c.title, team: c.id.startsWith('db:') })) };
  }

  @Get('usage')
  async usage() {
    const since = monthStart();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [merchant, byFeature, topStores, pubMonth, pubToday, pubBySite] = await Promise.all([
      this.prisma.aiUsage.aggregate({ where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, thoughtsTokens: true } }),
      this.prisma.aiUsage.groupBy({ by: ['feature'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.aiUsage.groupBy({ by: ['storeId'], where: { createdAt: { gte: since }, counted: true }, _count: { _all: true }, orderBy: { _count: { storeId: 'desc' } }, take: 8 }),
      this.prisma.aiPublicUsage.aggregate({ where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, thoughtsTokens: true } }),
      this.prisma.aiPublicUsage.count({ where: { createdAt: { gte: today } } }),
      this.prisma.aiPublicUsage.groupBy({ by: ['site'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const stores = await this.prisma.shopStore.findMany({ where: { id: { in: topStores.map((s) => s.storeId) } }, select: { id: true, name: true, slug: true } });
    const sum = (a: { _sum: { inputTokens: number | null; outputTokens: number | null; thoughtsTokens: number | null } }) => ({
      input: a._sum.inputTokens ?? 0, output: a._sum.outputTokens ?? 0, thoughts: a._sum.thoughtsTokens ?? 0,
    });
    return {
      since,
      merchant: { requests: merchant._count._all, tokens: sum(merchant), byFeature: Object.fromEntries(byFeature.map((f) => [f.feature, f._count._all])) },
      topStores: topStores.map((t) => ({ ...stores.find((s) => s.id === t.storeId), requests: t._count._all })),
      public: { requests: pubMonth._count._all, today: pubToday, tokens: sum(pubMonth), bySite: Object.fromEntries(pubBySite.map((s) => [s.site, s._count._all])) },
    };
  }
}

const clean = (tags?: string[]) => [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 30);
