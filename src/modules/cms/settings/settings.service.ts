import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService, tenantCreate } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { UpsertSettingDto } from './dto';

/**
 * إعدادات الموقع — زوج مفتاح/قيمة بلا حذف ناعم ولا مزامنة نسخ عمدًا؛
 * قيمة إعداد لا تاريخ لها يستحقّ التتبّع، الأحدث هو الصحيح دائمًا.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async findByKey(ctx: TenantContext, key: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const setting = await db.cmsSetting.findFirst({ where: { key } });
    if (!setting) {
      throw new NotFoundException('الإعداد غير موجود');
    }
    return setting;
  }

  /** إنشاء أو تحديث بالمفتاح — لا يهمّ المستدعي إن كان القيد موجودًا أصلًا. */
  async upsert(ctx: TenantContext, input: UpsertSettingDto) {
    const db = this.prisma.forTenant(ctx.companyId);
    const existing = await db.cmsSetting.findFirst({ where: { key: input.key } });

    if (existing) {
      return db.cmsSetting.update({
        where: { id: existing.id },
        data: { value: input.value, type: input.type, label: input.label },
      });
    }

    return db.cmsSetting.create({
      data: tenantCreate<Prisma.CmsSettingUncheckedCreateInput>({
        syncId: randomUUID(),
        key: input.key,
        value: input.value,
        type: input.type ?? 0,
        label: input.label,
      }),
    });
  }
}
