import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Public, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { PublicRateLimit } from '../../shop/public/rate-limit';
import { ContactsService } from './contacts.service';
import { SubmitContactDto, UpdateContactStatusDto } from './dto';

import { PlatformAlerts } from '../../notify/platform-alerts.service';
@Controller('cms/contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly limit: PublicRateLimit,
    private readonly alerts: PlatformAlerts,
  ) {}

  /**
   * نموذج التواصل العام — عام عمدًا، انظر توثيق `submitPublic` في
   * الخدمة. المسار الوحيد في هذه الوحدة الذي لا يتطلّب مصادقة.
   */
  @Public()
  @Post('public')
  async submitPublic(@Body() dto: SubmitContactDto, @Ip() ip: string) {
    // خمس رسائل في الساعة من عنوان واحد — تكفي زائرًا حقيقيًا وتقطع السيل الآلي
    this.limit.check(`contact:${ip}`, Number(process.env.CONTACT_LIMIT) || 5, 60 * 60_000);
    const saved = await this.contacts.submitPublic(dto);
    void this.alerts.raise({
      kind: 'contact',
      title: `رسالة جديدة من الموقع — ${dto.name}`,
      body: [dto.phone ? `الهاتف: ${dto.phone}` : '', dto.email ? `البريد: ${dto.email}` : '', String(dto.message ?? '').slice(0, 400)].filter(Boolean).join('\n'),
      link: '/site/messages',
    });
    return saved;
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
