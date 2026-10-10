import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../common/prisma/tenant-prisma.service';
import { generateApiKey, hashApiKey } from '../../common/security/api-key.util';
import { TenantContext } from '../../common/tenant/tenant-context';
import { CreateApiKeyDto } from './dto';

/**
 * إصدار مفاتيح API وإدارتها — التحقّق الفعلي منها في `TenantGuard`
 * (نفس خوارزمية التجزئة من `api-key.util.ts`)، هذه الوحدة تُصدر وتسرد
 * وتُلغي فقط، ولا تُعيد السرّ الكامل بعد لحظة الإنشاء أبدًا.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private strip<T extends { keyHash: string }>(row: T): Omit<T, 'keyHash'> {
    const { keyHash: _keyHash, ...rest } = row;
    void _keyHash;
    return rest;
  }

  async list(ctx: TenantContext) {
    const rows = await this.prisma.forTenant(ctx.companyId).apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.strip(r));
  }

  /** يُصدر مفتاحًا ويعيد سرّه الكامل — المرة الوحيدة التي يظهر فيها. */
  async create(ctx: TenantContext, dto: CreateApiKeyDto) {
    if (dto.role < ctx.role) {
      throw new ForbiddenException('لا يمكنك إصدار مفتاح بصلاحية أعلى من دورك');
    }

    const { secret, prefix } = generateApiKey();
    const row = await this.prisma.forTenant(ctx.companyId).apiKey.create({
      data: tenantCreate<Prisma.ApiKeyUncheckedCreateInput>({
        syncId: randomUUID(),
        name: dto.name.trim(),
        prefix,
        keyHash: hashApiKey(secret),
        role: dto.role,
        createdBy: ctx.userId,
      }),
    });

    return { ...this.strip(row), secret };
  }

  async revoke(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const key = await db.apiKey.findFirst({ where: { id } });
    if (!key) throw new NotFoundException('المفتاح غير موجود');
    if (!key.revokedAt) {
      await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    }
    return { ok: true };
  }
}
