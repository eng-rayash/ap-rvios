import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';

/**
 * AZM — الاجتماعات
 *
 * النموذج الذي تتبعه بقية وحدات الموارد: **كل استعلام يمرّ عبر
 * `forTenant`**، فلا يستطيع هذا الملف رؤية بيانات شركة أخرى ولو
 * حاول. المرشّح يُحقن في الطبقة لا هنا.
 *
 * لاحظ أن `companyId` لا يُذكر في أي استعلام أدناه — وهذا هو المقصود:
 * ما لا يُكتب لا يُنسى.
 */
@Injectable()
export class MeetingsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async findAll(ctx: TenantContext, params?: { since?: Date }) {
    const db = this.prisma.forTenant(ctx.companyId);

    return db.meeting.findMany({
      where: {
        deletedAt: null,
        // المزامنة التفاضلية: العميل يطلب ما تغيّر بعد آخر مزامنة
        ...(params?.since ? { updatedAt: { gt: params.since } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const meeting = await db.meeting.findUnique({ where: { id } });

    // `forTenant` يعيد `null` لصفّ شركة أخرى، فيصير «غير موجود» من
    // منظور الطالب — ولا نكشف حتى وجوده.
    if (!meeting || meeting.deletedAt) {
      throw new NotFoundException('الاجتماع غير موجود');
    }
    return meeting;
  }

  async create(ctx: TenantContext, input: CreateMeetingInput) {
    const db = this.prisma.forTenant(ctx.companyId);

    return db.meeting.create({
      // `companyId` غائب عمدًا — الطبقة تحقنه. `tenantCreate` هو
      // الموضع الوحيد الذي يُعلن فيه هذا للمُصرِّف.
      data: tenantCreate<Prisma.MeetingUncheckedCreateInput>({
        // العميل يرسل `syncId` حين يكون الصفّ أُنشئ محليًا أولًا،
        // فيبقى المعرّف نفسه على الطرفين وتقع المطابقة عليه.
        syncId: input.syncId ?? randomUUID(),
        title: input.title,
        date: input.date,
        time: input.time,
        endTime: input.endTime,
        location: input.location,
        objective: input.objective,
        meetingType: input.meetingType ?? 0,
        meetingCategory: input.meetingCategory ?? 0,
        priority: input.priority ?? 2,
        status: input.status ?? 0,
        // التضييق هنا لا في الـDTO: هذا هو حدّ Prisma، والـDTO يصف
        // ما يقبله الشبكة لا ما يخزّنه المحرّك.
        agenda: input.agenda as Prisma.InputJsonValue | undefined,
        attendees: input.attendees as Prisma.InputJsonValue | undefined,
        createdBy: ctx.userId,
      }),
    });
  }

  /**
   * تعديل بقفل تفاؤلي.
   *
   * [expectedVersion] يمنع الكتابة فوق تعديل أحدث: جهازان يحرّران
   * الاجتماع نفسه دون اتصال، وأولهما وصولًا يفوز — والثاني يُبلَّغ
   * بالتعارض بدل أن يمحو عمل الأول صامتًا.
   */
  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateMeetingInput,
    expectedVersion?: number,
  ) {
    const db = this.prisma.forTenant(ctx.companyId);
    const current = await this.findOne(ctx, id);

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionConflictError(current.version, expectedVersion);
    }

    return db.meeting.update({
      where: { id },
      data: {
        ...(input as Prisma.MeetingUpdateInput),
        version: { increment: 1 },
      },
    });
  }

  /**
   * حذف ناعم — الحذف حدث يُزامَن لا غياب صفّ.
   *
   * الحذف الصلب يجعل الصفّ يختفي عن الخادم بينما يبقى على أجهزة لم
   * تتزامن بعد، ثم يعود إليها في أول دفع.
   */
  async remove(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    await this.findOne(ctx, id);

    return db.meeting.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }
}

export interface CreateMeetingInput {
  syncId?: string;
  title: string;
  date: string;
  time: string;
  endTime?: string;
  location?: string;
  objective?: string;
  meetingType?: number;
  meetingCategory?: number;
  priority?: number;
  status?: number;
  /** حقول JSON كما تصل من الشبكة — تُضيَّق عند الكتابة. */
  agenda?: Record<string, unknown>;
  attendees?: Record<string, unknown>;
}

export type UpdateMeetingInput = Partial<
  Omit<CreateMeetingInput, 'syncId'>
>;

/** يُرمى حين يحاول تعديل الكتابة فوق نسخة أحدث. */
export class VersionConflictError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly expectedVersion: number,
  ) {
    super(
      `تعارض نسخ: السجلّ عند النسخة ${currentVersion} ` +
        `والتعديل مبنيّ على ${expectedVersion}`,
    );
    this.name = 'VersionConflictError';
  }
}
