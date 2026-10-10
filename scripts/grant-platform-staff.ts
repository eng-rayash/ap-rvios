/**
 * AZM — منح صلاحية فريق المنصة
 *
 * لا واجهة لهذا عمدًا: منح موظف صلاحية عبر كل الشركات فعل نادر وحسّاس،
 * يُنفَّذ من طرفية بوصول مباشر لقاعدة الإنتاج، لا زرًّا في تطبيق يمكن
 * الضغط عليه بالخطأ.
 *
 * الاستخدام:
 *   npm run platform:grant -- <email> [role]
 *   role: 0=دعم (افتراضي) · 1=فوترة · 2=مدير عام
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const [email, roleArg] = process.argv.slice(2);
  if (!email) {
    console.error('الاستخدام: grant-platform-staff.ts <email> [role=0]');
    process.exit(1);
  }

  const role = roleArg ? Number(roleArg) : 0;
  if (!Number.isInteger(role) || role < 0 || role > 2) {
    console.error('role يجب أن يكون 0 أو 1 أو 2');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.update({
      where: { email: email.trim().toLowerCase() },
      data: { isPlatformStaff: true, platformRole: role },
      select: { id: true, email: true, displayName: true },
    });
    console.log(`منح ${user.displayName} (${user.email}) صلاحية فريق المنصة — role=${role}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
