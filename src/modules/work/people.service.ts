import { BadRequestException, Injectable } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
}

/**
 * أعضاء الشركة كأشخاص للعرض والتحقق. المستخدمون في وحدة العمل معرّفات
 * نصية بلا مفتاح أجنبي، فهنا نضمن (١) أن أي معرّف يُكتب عضو فعّال في
 * الشركة نفسها، و(٢) نُرجع أسماءهم دفعة واحدة عند القراءة.
 */
@Injectable()
export class PeopleService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** يرفض أي معرّف ليس عضوًا فعّالًا في الشركة. */
  async assertMembers(companyId: string, userIds: (string | null | undefined)[]) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return;
    const found = await this.prisma.membership.count({
      where: { organizationId: companyId, userId: { in: ids }, isActive: true, deletedAt: null },
    });
    if (found !== ids.length) {
      throw new BadRequestException('أحد المستخدمين المحدَّدين ليس عضوًا في الشركة');
    }
  }

  async byIds(companyId: string, userIds: (string | null | undefined)[]): Promise<Map<string, Person>> {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    const map = new Map<string, Person>();
    if (!ids.length) return map;
    const rows = await this.prisma.membership.findMany({
      where: { organizationId: companyId, userId: { in: ids }, deletedAt: null },
      select: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    for (const r of rows) {
      map.set(r.user.id, { id: r.user.id, name: r.user.displayName, avatar: r.user.avatarUrl });
    }
    return map;
  }
}
