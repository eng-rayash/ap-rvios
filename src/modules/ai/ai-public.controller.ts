import { Body, Controller, HttpCode, Ip, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../../common/tenant/tenant.guard';
import { AiPublicChatDto } from './ai-public.dto';
import { AiPublicService } from './ai-public.service';

/**
 * مساعد الزوّار — مسار عام بلا جلسة. الأصول المسموح لها في `AI_PUBLIC_ORIGINS` (انظر main.ts)،
 * والحدود في الخدمة. الرد بثّ SSE كمساعد التاجر.
 */
@Controller('ai/public')
export class AiPublicController {
  constructor(private readonly ai: AiPublicService) {}

  @Public()
  @Post('chat')
  @HttpCode(200)
  async chat(@Body() dto: AiPublicChatDto, @Ip() ip: string, @Res() res: Response) {
    const prep = await this.ai.prepare(dto, ip);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    try {
      for await (const ev of this.ai.run(dto, prep, abort.signal)) {
        if (res.writableEnded) break;
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } finally {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
  }
}
