import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { Public } from '../../common/tenant/tenant.guard';

/**
 * فحص الصحّة للاستضافة وموازن الحمل: `200` حين يصل الخادم إلى قاعدته،
 * و`503` حين لا يصل — فلا يُوجَّه إليه زوّار وهو بلا قاعدة.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ ok: false, db: 'down' });
    }
    return { ok: true, db: 'up', uptime: Math.round(process.uptime()) };
  }
}
