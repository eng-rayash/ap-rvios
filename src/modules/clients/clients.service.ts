import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { normalizeArabic } from '../../common/text/normalize-arabic';
import { VersionConflictError } from '../meetings/meetings.service';

/**
 * AZM — العملاء
 *
 * يتبع نموذج `MeetingsService` حرفيًا: كل استعلام عبر `forTenant`،
 * ولا `companyId` في أي مكان هنا.
 *
 * الفارق الوحيد: `nameNormalized` يُشتقّ من `name` عند كل كتابة —
 * انظر تسويغه في `normalize-arabic.ts`. بدونه لا يطابق بحث «احمد»
 * عميلًا اسمه «أحمد».
 */
@Injectable()
export class ClientsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async findAll(ctx: TenantContext, params?: { since?: Date }) {
    const db = this.prisma.forTenant(ctx.companyId);

    return db.client.findMany({
      where: {
        deletedAt: null,
        ...(params?.since ? { updatedAt: { gt: params.since } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const client = await db.client.findUnique({ where: { id } });

    if (!client || client.deletedAt) {
      throw new NotFoundException('العميل غير موجود');
    }
    return client;
  }

  async create(ctx: TenantContext, input: CreateClientInput) {
    const db = this.prisma.forTenant(ctx.companyId);
    const name = input.name.trim();

    return db.client.create({
      data: tenantCreate<Prisma.ClientUncheckedCreateInput>({
        syncId: input.syncId ?? randomUUID(),
        name,
        nameNormalized: normalizeArabic(name),
        phone: input.phone,
        email: input.email,
        address: input.address,
        city: input.city,
        taxNumber: input.taxNumber,
        createdBy: ctx.userId,
      }),
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateClientInput,
    expectedVersion?: number,
  ) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }

    const name = input.name?.trim();

    return db.client.update({
      where: { id },
      data: {
        ...(input as Prisma.ClientUpdateInput),
        // الاسم والتطبيع يتغيّران معًا دائمًا — لا مسار يُحدَّث فيه
        // أحدهما دون الآخر، وإلا فقد البحث تزامنه مع الاسم المعروض.
        ...(name !== undefined
          ? { name, nameNormalized: normalizeArabic(name) }
          : {}),
        version: { increment: 1 },
      },
    });
  }

  /** حذف ناعم. يتطلّب مدير قسم فأعلى — انظر تسويغه في الاجتماعات. */
  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);

    return db.client.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }
}

export interface CreateClientInput {
  syncId?: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  taxNumber?: string;
}

export type UpdateClientInput = Partial<Omit<CreateClientInput, 'syncId'>>;
