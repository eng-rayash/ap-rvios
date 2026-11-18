import type { TenantPrismaService } from '../../src/common/prisma/tenant-prisma.service';

/**
 * يرفع باقة متجر في الاختبار — لاختبار وحدة مقفلة بالباقة دون المرور بالفوترة.
 * 3 = الأعمال (كل المزايا). الاشتراك يُنشأ إن غاب.
 */
export async function upgradeStore(prisma: TenantPrismaService, companyId: string, storeId: string, plan = 3) {
  const end = new Date(Date.now() + 365 * 86_400_000);
  const found = await prisma.storeSubscription.findFirst({ where: { companyId, storeRef: storeId } });
  if (found) {
    await prisma.storeSubscription.update({ where: { id: found.id }, data: { plan, status: 0, currentPeriodEnd: end } });
  } else {
    await prisma.storeSubscription.create({ data: { syncId: crypto.randomUUID(), companyId, storeRef: storeId, plan, status: 0, currentPeriodEnd: end } });
  }
}
