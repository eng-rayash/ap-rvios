import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { SITE_WORKSPACE_SLUG } from '../site-organization.constant';
import { SubmitContactDto, UpdateContactStatusDto } from './dto';

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  findAll(ctx: TenantContext, status?: number) {
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsContact.findMany({
      where: { deletedAt: null, ...(status !== undefined ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async findOne(ctx: TenantContext, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const contact = await db.cmsContact.findUnique({ where: { id } });
    if (!contact || contact.deletedAt) {
      throw new NotFoundException('الرسالة غير موجودة');
    }
    return contact;
  }

  async updateStatus(ctx: TenantContext, id: string, input: UpdateContactStatusDto) {
    await this.findOne(ctx, id);
    const db = this.prisma.forTenant(ctx.companyId);
    return db.cmsContact.update({
      where: { id },
      data: { status: input.status, version: { increment: 1 } },
    });
  }

  /**
   * استقبال نموذج التواصل العام على الموقع — **بلا مصادقة**، فالطالب
   * زائر لا مستخدم. لا `TenantContext` هنا أصلًا؛ الشركة تُحلّ من
   * `SITE_WORKSPACE_SLUG` الثابت لا من أي قيمة يرسلها الطالب — هذا هو
   * الاستثناء الوحيد المتعمَّد الذي يكتب في منظمة محدَّدة دون عبور
   * `forTenant()`، ومسوَّغ لأن الشركة هنا ثابتة معروفة سلفًا لا مُختارة.
   */
  async submitPublic(input: SubmitContactDto) {
    const email = input.email?.trim() || null;
    const phone = input.phone?.trim() || null;
    // رسالة بلا وسيلة رجوع لا يُردّ عليها — تُرفض بدل أن تُخزَّن ميتة
    if (!email && !phone) throw new BadRequestException('اترك بريدًا أو رقم تواصل');

    const site = await this.prisma.organization.findUnique({
      where: { workspaceSlug: SITE_WORKSPACE_SLUG },
      select: { id: true },
    });
    if (!site) {
      // لا تفصيل أكثر للزائر — هذا عطل تهيئة عندنا لا خطؤه.
      throw new ServiceUnavailableException('تعذّر استقبال رسالتك، حاول لاحقًا');
    }

    return this.prisma.cmsContact.create({
      data: {
        syncId: randomUUID(),
        companyId: site.id,
        name: input.name,
        email,
        phone,
        service: input.service,
        message: input.message,
      },
    });
  }
}
