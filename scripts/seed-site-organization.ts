/**
 * AZM — تهيئة منظمة الموقع الرئيسي
 *
 * الموقع الرئيسي (rvios.com) ليس نموذج استئجار خاصًا — هو صفّ
 * [Organization] واحد محجوز، تمامًا كما هو موثَّق في `schema.prisma`.
 * هذا السكربت يُنشئ ذلك الصفّ الوحيد (مرّة واحدة فقط، لا واجهة لهذا
 * عمدًا — نفس تسويغ `grant-platform-staff.ts`) ويضيف أول محرِّر لها.
 *
 * الاستخدام:
 *   npm run cms:seed-site -- <owner-email>
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { SITE_WORKSPACE_SLUG } from '../src/modules/cms/site-organization.constant';

const SITE_COMPANY_CODE = 'SITE-MAIN';
const SITE_NAME = 'RVIOS — الموقع الرئيسي';

async function main() {
  const [email] = process.argv.slice(2);
  if (!email) {
    console.error('الاستخدام: seed-site-organization.ts <owner-email>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, displayName: true, email: true },
    });
    if (!user) {
      console.error(`لا مستخدم بهذا البريد: ${email}. سجّله أولًا عبر /auth/register.`);
      process.exit(1);
    }

    let org = await prisma.organization.findUnique({
      where: { workspaceSlug: SITE_WORKSPACE_SLUG },
    });

    if (!org) {
      org = await prisma.organization.create({
        data: {
          syncId: randomUUID(),
          companyCode: SITE_COMPANY_CODE,
          workspaceSlug: SITE_WORKSPACE_SLUG,
          name: SITE_NAME,
          language: 'ar',
        },
      });
      console.log(`أُنشئت منظمة الموقع: ${org.name} (${org.id})`);
    } else {
      console.log(`منظمة الموقع موجودة أصلًا: ${org.name} (${org.id})`);
    }

    const existing = await prisma.membership.findFirst({
      where: { userId: user.id, organizationId: org.id },
    });

    if (existing) {
      console.log(`${user.displayName} عضو أصلًا في منظمة الموقع.`);
      return;
    }

    await prisma.membership.create({
      data: {
        syncId: randomUUID(),
        userId: user.id,
        organizationId: org.id,
        role: 0, // Owner
        isActive: true,
        joinedAt: new Date(),
      },
    });
    console.log(`أُضيف ${user.displayName} (${user.email}) مالكًا لمنظمة الموقع.`);
    console.log(`\nمعرّف المنظمة: ${org.id}`);
    console.log('عند تسجيل الدخول، مرّر companyId هذا إن امتلك المستخدم أكثر من شركة.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
