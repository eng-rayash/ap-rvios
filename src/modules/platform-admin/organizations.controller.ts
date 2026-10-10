import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';

import { Platform, PlatformOnly } from '../../common/tenant/tenant.guard';
import { PlatformContext } from '../../common/tenant/tenant-context';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

/** مسارات إدارة الشركات — فريق منصة RVIOS فقط، عبر كل المستأجرين. */
@PlatformOnly()
@Controller('platform/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  findAll(@Platform() _ctx: PlatformContext) {
    return this.organizations.findAll();
  }

  @Get(':id')
  findOne(
    @Platform() _ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.organizations.findOne(id);
  }

  @Patch(':id')
  updatePlan(
    @Platform() _ctx: PlatformContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizations.updatePlan(id, dto);
  }
}
