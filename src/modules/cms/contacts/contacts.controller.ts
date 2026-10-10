import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Public, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { PublicRateLimit } from '../../shop/public/rate-limit';
import { ContactsService } from './contacts.service';
import { SubmitContactDto, UpdateContactStatusDto } from './dto';

@Controller('cms/contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly limit: PublicRateLimit,
  ) {}

  /**
   * نموذج التواصل العام — عام عمدًا، انظر توثيق `submitPublic` في
   * الخدمة. المسار الوحيد في هذه الوحدة الذي لا يتطلّب مصادقة.
   */
  @Public()
  @Post('public')
  submitPublic(@Body() dto: SubmitContactDto, @Ip() ip: string) {
    // خمس رسائل في الساعة من عنوان واحد — تكفي زائرًا حقيقيًا وتقطع السيل الآلي
    this.limit.check(`contact:${ip}`, Number(process.env.CONTACT_LIMIT) || 5, 60 * 60_000);
    return this.contacts.submitPublic(dto);
  }

  @Get()
  findAll(@Tenant() ctx: TenantContext, @Query('status') status?: string) {
    const parsed = status !== undefined ? Number(status) : undefined;
    return this.contacts.findAll(ctx, Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get(':id')
  findOne(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.findOne(ctx, id);
  }

  @Patch(':id/status')
  updateStatus(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContactStatusDto,
  ) {
    return this.contacts.updateStatus(ctx, id, dto);
  }
}
