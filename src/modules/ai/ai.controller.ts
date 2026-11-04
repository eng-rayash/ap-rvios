import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { AiChatDto, AiGenerateDto, AiRenameDto } from './ai.dto';
import { AiService } from './ai.service';

/**
 * RVIOS AI — مسارات التاجر، كلها داخل متجر بعينه: `ShopStoreAccessService` يتحقق
 * أن المتجر لشركة الجلسة قبل أي شيء، ومعرّف المتجر من العميل لا يُصدَّق وحده.
 * الضيف (Guest) لا يستعمل المساعد: الطلبات تُكلِّف وتُحتسب على حصّة المتجر.
 */
@Controller('shop/stores/:storeId/ai')
@RequireRole(UserRole.Employee)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.ai.status(ctx, storeId);
  }

  @Get('conversations')
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.ai.list(ctx, storeId);
  }

  @Get('conversations/:id')
  get(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.get(ctx, storeId, id);
  }

  @Patch('conversations/:id')
  rename(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AiRenameDto,
  ) {
    return this.ai.rename(ctx, storeId, id, dto.title);
  }

  @Delete('conversations/:id')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.remove(ctx, storeId, id);
  }

  /**
   * الرد بثًّا (Server-Sent Events) على POST. التحضير — المتجر والحصّة والمحادثة —
   * قبل فتح البث، فأخطاؤه تصل ردودًا عادية برموزها (٤٢٩، ٤٠٤…). بعد الفتح تصل
   * الأخطاء حدثًا `error`. إغلاق التاجر للصفحة أو ضغطه «إيقاف» يُلغي الطلب عند
   * المزوّد فلا يُكمل توليدًا لا يقرؤه أحد.
   */
  @Post('chat')
  @HttpCode(200)
  async chat(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: AiChatDto,
    @Res() res: Response,
  ) {
    const run = await this.ai.prepareChat(ctx, storeId, dto);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // خلف nginx وأمثاله: بلا هذا تُجمَّع الأحداث وتصل دفعة واحدة في النهاية
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // نبضة كل ١٥ ثانية: الوسطاء يقطعون الاتصال الصامت الطويل
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    try {
      for await (const ev of this.ai.runChat(run, abort.signal)) {
        if (res.writableEnded) break;
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } finally {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
  }

  /** أدوات الكتابة: كاتب المنتجات، والتسويق، والسيو — نتيجة JSON يحرّرها التاجر */
  @Post('generate')
  @HttpCode(200)
  generate(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: AiGenerateDto,
  ) {
    return this.ai.generate(ctx, storeId, dto);
  }
}
