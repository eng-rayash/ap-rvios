import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { UpdateMeetingDto } from './dto/update-meeting.dto';
import { MeetingsService } from './meetings.service';

/**
 * AZM — مسارات الاجتماعات
 *
 * النموذج الذي تتبعه بقية الوحدات. ثلاث ملاحظات:
 *
 * ١. `ctx` يأتي من الحارس لا من الطلب. لا مسار هنا يقبل `companyId`.
 *
 * ٢. `since` يخدم المزامنة التفاضلية: الجهاز يرسل آخر وقت زامن فيه
 *    فيستقبل ما تغيّر بعده فقط، بدل مئتي صفّ في كل مرة.
 *
 * ٣. `If-Match` يحمل النسخة المتوقَّعة للقفل التفاؤلي. الترويسة لا
 *    الجسم: النسخة خاصية بالطلب لا بالمورد المُعدَّل.
 */
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  findAll(
    @Tenant() ctx: TenantContext,
    @Query('since') since?: string,
  ) {
    // تاريخ غير صالح يُتجاهَل فيُعاد كل شيء — أسلم من ردّ فارغ يُفهم
    // على أنه «لا جديد» فيوقف المزامنة صامتة.
    const parsed = since ? new Date(since) : undefined;
    const valid =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;

    return this.meetings.findAll(ctx, { since: valid });
  }

  @Get(':id')
  findOne(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.meetings.findOne(ctx, id);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateMeetingDto) {
    return this.meetings.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMeetingDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expected = ifMatch ? Number(ifMatch) : undefined;
    return this.meetings.update(
      ctx,
      id,
      dto,
      Number.isFinite(expected) ? expected : undefined,
    );
  }

  /**
   * حذف ناعم. يتطلّب مدير قسم فأعلى.
   *
   * الحذف أخطر من التعديل: التعديل يترك السجلّ مرئيًا فيُلاحَظ،
   * والحذف يُخفيه.
   */
  @RequireRole(UserRole.DeptManager)
  @Delete(':id')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.meetings.remove(ctx, id);
  }
}
