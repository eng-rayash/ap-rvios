/**
 * AZM — تهيئة شركة العرض التجريبي
 *
 * شركة كاملة ببيانات واقعية في كل وحدة — فريق وعملاء وفواتير واجتماعات ومشاريع
 * ومهام ومتجر بمنتجاته وطلباته وزياراته وتقييماته — يدخلها أي زائر من صفحة
 * «جرّب العرض» في AzmSmart (`POST /auth/demo`) للمشاهدة فقط.
 *
 * يُعاد بناؤها من الصفر في كل تشغيل (يحذف شركة العرض وبياناتها أولًا)، والتواريخ
 * نسبية إلى يوم التشغيل — فأعد تشغيله كل بضعة أشهر لتبقى الرسوم حديثة.
 *
 * الاستخدام:
 *   npm run demo:seed             (تطوير)
 *   npm run demo:seed:prod        (من البناء — داخل الحاوية)
 */
import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';

import { normalizeArabic } from '../src/common/text/normalize-arabic';
import { DEMO_EMAIL, DEMO_WORKSPACE_SLUG } from '../src/modules/demo/demo.constant';

// يُنشأ عند التشغيل (سطر أوامر أو من الخادم عند الإقلاع) ويُغلق بعده
let prisma: PrismaClient;
const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number, hour = 10, min = 0) => {
  const d = new Date(now - days * DAY);
  d.setHours(hour, min, 0, 0);
  return d;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// مولّد أرقام شبه عشوائي ثابت — البيانات نفسها في كل تشغيل
let seed = 20261010;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const IMG = (id: string, w = 1200) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

// ───────────────────────── الفريق ─────────────────────────
const TEAM = [
  { key: 'owner', name: 'عبدالله الحميري', email: DEMO_EMAIL, role: 0 },
  { key: 'sara', name: 'سارة القحطاني', email: 'sara@azmsmart.demo', role: 2 },
  { key: 'omar', name: 'عمر باوزير', email: 'omar@azmsmart.demo', role: 5 },
  { key: 'huda', name: 'هدى الشامي', email: 'huda@azmsmart.demo', role: 4 },
  { key: 'khaled', name: 'خالد المقطري', email: 'khaled@azmsmart.demo', role: 7 },
  { key: 'mona', name: 'منى العبسي', email: 'mona@azmsmart.demo', role: 8 },
  { key: 'yousef', name: 'يوسف الحداد', email: 'yousef@azmsmart.demo', role: 8 },
] as const;
type Key = (typeof TEAM)[number]['key'];

async function wipe() {
  const org = await prisma.organization.findUnique({ where: { workspaceSlug: DEMO_WORKSPACE_SLUG } });
  if (org) {
    const where = { companyId: org.id };
    // الأبناء قبل الآباء
    await prisma.shopReview.deleteMany({ where });
    await prisma.shopOrderItem.deleteMany({ where });
    await prisma.shopOrder.deleteMany({ where });
    await prisma.shopCustomer.deleteMany({ where });
    await prisma.shopVisit.deleteMany({ where });
    await prisma.shopProductVariant.deleteMany({ where });
    await prisma.shopProductImage.deleteMany({ where }).catch(() => undefined);
    await prisma.shopProduct.deleteMany({ where });
    await prisma.shopCategory.deleteMany({ where });
    await prisma.shopDeliveryZone.deleteMany({ where });
    await prisma.shopSlugHistory.deleteMany({ where }).catch(() => undefined);
    await prisma.storeSubscription.deleteMany({ where });
    await prisma.shopStore.deleteMany({ where });
    await prisma.workTaskComment.deleteMany({ where });
    await prisma.workTask.deleteMany({ where });
    await prisma.workMilestone.deleteMany({ where });
    await prisma.workProjectMember.deleteMany({ where });
    await prisma.workProject.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await prisma.followUp.deleteMany({ where });
    await prisma.meeting.deleteMany({ where });
    await prisma.invoice.deleteMany({ where });
    await prisma.client.deleteMany({ where });
    await prisma.employee.deleteMany({ where });
    await prisma.membership.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: '@azmsmart.demo' } } });
}

async function main() {
  await wipe();

  // ─────────────── الشركة والفريق ───────────────
  const org = await prisma.organization.create({
    data: {
      syncId: randomUUID(), companyCode: 'DEMO-AZM', workspaceSlug: DEMO_WORKSPACE_SLUG,
      name: 'مؤسسة الواحة للتجارة', country: 'SA', currency: 'SAR', industry: 'retail', language: 'ar',
    },
  });
  const companyId = org.id;
  // لا أحد يدخل بكلمة مرور — الدخول من `POST /auth/demo` وحده
  const unusable = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
  const U = {} as Record<Key, string>;
  for (const m of TEAM) {
    const u = await prisma.user.create({
      data: { syncId: randomUUID(), email: m.email, passwordHash: unusable, displayName: m.name, language: 'ar', timezone: 'Asia/Riyadh' },
    });
    U[m.key] = u.id;
    await prisma.membership.create({
      data: { syncId: randomUUID(), userId: u.id, organizationId: companyId, role: m.role, isActive: true, joinedAt: ago(int(60, 300)) },
    });
  }
  const members = TEAM.map((m) => U[m.key]);

  // ─────────────── العملاء والفواتير ───────────────
  const CLIENTS = [
    ['مقهى ركن القهوة', 'الرياض', '+966501234101'], ['فندق قصر النخيل', 'جدة', '+966501234102'],
    ['شركة الضيافة الذهبية', 'الدمام', '+966501234103'], ['محامص الشروق', 'الرياض', '+966501234104'],
    ['مطاعم بيت الكرم', 'مكة المكرمة', '+966501234105'], ['متاجر الأسرة', 'الخبر', '+966501234106'],
    ['مؤسسة الريان للتموين', 'جدة', '+966501234107'], ['كافيه سطوح', 'الرياض', '+966501234108'],
    ['مجموعة دار الضيافة', 'المدينة المنورة', '+966501234109'], ['سوبرماركت الهدى', 'صنعاء', '+967771234110'],
    ['محلات العسل الملكي', 'عدن', '+967771234111'], ['شركة الوفاء للفعاليات', 'الرياض', '+966501234112'],
    ['ركن الهدايا الفاخرة', 'الدمام', '+966501234113'], ['مخبز الأصالة', 'أبها', '+966501234114'],
  ] as const;
  const clients: { id: string; name: string }[] = [];
  for (const [i, [name, city, phone]] of CLIENTS.entries()) {
    const c = await prisma.client.create({
      data: {
        syncId: randomUUID(), companyId, name, nameNormalized: normalizeArabic(name), phone, city,
        email: `contact${i + 1}@client.demo`, address: `${city} — الحي التجاري`, taxNumber: i % 3 === 0 ? `3${String(100000000 + i * 7919).slice(0, 9)}00003` : null,
        createdBy: U.sara, createdAt: ago(int(90, 200)),
      },
    });
    clients.push({ id: c.id, name });
  }
  const LINES = [
    ['بن حرازي محمّص (كيلو)', 180], ['بن خولاني (كيلو)', 210], ['عسل سدر حضرمي (كيلو)', 420], ['عسل سمر جبلي (كيلو)', 260],
    ['دلال نحاسية للضيافة', 145], ['خدمة تجهيز ركن قهوة للفعاليات', 1800], ['مطاحن يدوية', 95], ['فناجين فخارية (طقم ١٢)', 120],
  ] as const;
  // التوزيع: مدفوعة، مُرسلة، جزئية، متأخرة، مسودة، ملغاة
  const STATUSES = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 2, 2, 2, 4, 4, 4, 0, 0, 5];
  for (const [i, status] of STATUSES.entries()) {
    const issued = ago(int(2, 180));
    const items = Array.from({ length: int(1, 3) }, () => { const [description, unitPrice] = pick([...LINES]); return { description, quantity: int(2, 25), unitPrice }; });
    const subtotal = items.reduce((s, x) => s + x.quantity * x.unitPrice, 0);
    const discount = i % 5 === 0 ? Math.round(subtotal * 0.05) : 0;
    const taxPercent = 15;
    const tax = Math.round((subtotal - discount) * 0.15 * 100) / 100;
    const total = subtotal - discount + tax;
    const paid = status === 3 ? total : status === 2 ? Math.round(total * 0.4) : 0;
    const due = new Date(issued.getTime() + 30 * DAY);
    await prisma.invoice.create({
      data: {
        syncId: randomUUID(), companyId, invoiceNumber: `INV-2026-${String(i + 1).padStart(4, '0')}`, clientId: pick(clients).id,
        issueDate: ymd(issued), dueDate: ymd(status === 4 ? new Date(now - int(5, 20) * DAY) : due), items: items as unknown as Prisma.InputJsonValue,
        subtotal, discountAmount: discount, taxPercent, taxAmount: tax, total, paidAmount: paid, remainingAmount: Math.max(0, total - paid),
        currency: 'SAR', status, createdBy: U.omar, createdAt: issued,
      },
    });
  }

  // ─────────────── الاجتماعات والمتابعات ───────────────
  const MEETINGS = [
    ['مراجعة مبيعات الشهر', -1, '10:00', 'قاعة الاجتماعات', 'مقارنة المبيعات بالمستهدف وخطة الأسبوع القادم'],
    ['عرض تجهيز ركن القهوة — فندق قصر النخيل', 2, '13:30', 'مقر العميل — جدة', 'تقديم عرض الأسعار والعينات'],
    ['تخطيط حملة الموسم', 4, '11:00', 'اجتماع مرئي', 'اعتماد الرسائل والميزانية والقنوات'],
    ['متابعة توريد عسل السدر', 6, '09:30', 'المستودع', 'الكميات المتاحة ومواعيد الشحن'],
    ['مقابلة مرشّح خدمة العملاء', 8, '12:00', 'مكتب الموارد البشرية', 'المقابلة الثانية'],
    ['مراجعة أداء المتجر الإلكتروني', -6, '15:00', 'اجتماع مرئي', 'معدل التحويل وأكثر المنتجات طلبًا'],
    ['اجتماع الفريق الأسبوعي', -3, '09:00', 'قاعة الاجتماعات', 'المهام المتأخرة وأولويات الأسبوع'],
    ['توقيع عقد التوريد — محامص الشروق', 11, '14:00', 'مقر العميل — الرياض', 'توقيع العقد السنوي'],
    ['ورشة تدريب على نظام AzmSmart', 15, '10:30', 'قاعة التدريب', 'تدريب الفريق على الفواتير والمتجر'],
  ] as const;
  const meetingIds: string[] = [];
  for (const [title, inDays, time, location, objective] of MEETINGS) {
    const d = new Date(now + inDays * DAY);
    const [h, m] = time.split(':').map(Number);
    const m2 = await prisma.meeting.create({
      data: {
        syncId: randomUUID(), companyId, title, date: ymd(d), time, endTime: `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        location, objective, status: inDays < 0 ? 2 : 0, createdBy: U.owner, createdAt: ago(Math.max(1, 10 - inDays)),
      },
    });
    meetingIds.push(m2.id);
  }
  const FOLLOWUPS = [
    ['إرسال عرض السعر المعدّل لفندق قصر النخيل', 2, 'sara'], ['تحصيل الدفعة المتبقية من مطاعم بيت الكرم', -2, 'omar'],
    ['تجهيز عينات البن للحملة', 3, 'khaled'], ['تحديث صور المنتجات في المتجر', 1, 'mona'],
    ['مراجعة عقد محامص الشروق قانونيًا', 7, 'owner'], ['متابعة شحنة العسل مع المورّد', 4, 'yousef'],
    ['إعداد تقرير المبيعات الشهري', -1, 'omar'], ['جدولة مقابلات خدمة العملاء', 5, 'huda'],
  ] as const;
  for (const [i, [title, inDays, who]] of FOLLOWUPS.entries()) {
    await prisma.followUp.create({
      data: {
        syncId: randomUUID(), companyId, title, targetDate: ymd(new Date(now + inDays * DAY)), priority: i % 3, status: inDays < 0 ? 2 : 0,
        assignedTo: U[who], meetingId: meetingIds[i % meetingIds.length], createdBy: U.owner, createdAt: ago(int(2, 12)),
        ...(inDays < 0 ? { completedAt: ago(1) } : {}),
      },
    });
  }

  // ─────────────── المشاريع والمهام ───────────────
  const PROJECTS = [
    {
      key: 'WEB', name: 'إطلاق المتجر الإلكتروني الجديد', status: 0, color: '#C1272D', category: 'تجارة إلكترونية', lead: 'sara' as Key,
      start: -60, due: 25, budget: 45000, spent: 31000, members: ['sara', 'khaled', 'mona', 'yousef'] as Key[],
      milestones: [['تصميم الواجهة', -40, true], ['رفع المنتجات والصور', -12, true], ['ربط الدفع والتوصيل', 8, false], ['الإطلاق الرسمي', 25, false]] as const,
      tasks: [
        ['اعتماد قالب المتجر وألوان الهوية', 4, 2, 'sara'], ['تصوير المنتجات بخلفية موحّدة', 4, 1, 'mona'], ['كتابة أوصاف المنتجات', 4, 1, 'mona'],
        ['إعداد مناطق التوصيل والرسوم', 3, 2, 'khaled'], ['ربط النطاق الخاص بالمتجر', 2, 2, 'yousef'], ['اختبار مسار الطلب من الجوال', 2, 3, 'khaled'],
        ['إعداد قوالب رسائل واتساب', 1, 1, 'yousef'], ['خطة إعلانات الإطلاق', 1, 2, 'sara'], ['سياسة الاستبدال والاسترجاع', 0, 0, 'owner'],
        ['صفحة الأسئلة الشائعة', 0, 0, 'mona'], ['تدريب الفريق على إدارة الطلبات', 1, 1, 'khaled'],
      ] as [string, number, number, Key][],
    },
    {
      key: 'ERP', name: 'ربط المخزون بين الفروع', status: 1, color: '#2563EB', category: 'عمليات', lead: 'khaled' as Key,
      start: -35, due: 12, budget: 28000, spent: 24500, members: ['khaled', 'omar', 'yousef'] as Key[],
      milestones: [['حصر المخزون الحالي', -20, true], ['توحيد رموز الأصناف', -2, false], ['تفعيل التنبيهات', 12, false]] as const,
      tasks: [
        ['جرد مستودع الرياض', 4, 2, 'yousef'], ['جرد مستودع جدة', 4, 2, 'yousef'], ['توحيد رموز الأصناف (SKU)', 2, 3, 'khaled'],
        ['تحديد حدود المخزون المنخفض', 2, 2, 'omar'], ['مطابقة الكميات مع الفواتير', 3, 2, 'omar'], ['تنبيهات نفاد المخزون', 1, 3, 'khaled'],
        ['تقرير حركة الأصناف الأسبوعي', 0, 1, 'omar'],
      ] as [string, number, number, Key][],
    },
    {
      key: 'MKT', name: 'حملة موسم القهوة', status: 3, color: '#059669', category: 'تسويق', lead: 'mona' as Key,
      start: -90, due: -15, budget: 18000, spent: 16800, members: ['mona', 'sara'] as Key[],
      milestones: [['الهوية البصرية للحملة', -70, true], ['إطلاق الحملة', -45, true], ['تقرير النتائج', -15, true]] as const,
      tasks: [
        ['تصميم منشورات الحملة', 4, 1, 'mona'], ['فيديو تحضير القهوة اليمنية', 4, 2, 'mona'], ['التعاون مع صنّاع المحتوى', 4, 2, 'sara'],
        ['كود خصم للعملاء الجدد', 4, 1, 'sara'], ['تقرير نتائج الحملة', 4, 1, 'mona'],
      ] as [string, number, number, Key][],
    },
  ];
  const LABELS = ['تصميم', 'محتوى', 'تقني', 'عاجل', 'عميل'];
  const COMMENTS = ['تم رفع النسخة الأولى، أرجو المراجعة.', 'ممتاز — نعتمدها بعد تعديل بسيط على الألوان.', 'بانتظار ردّ المورّد قبل الإكمال.', 'أنجزت الجزء الأكبر وأكمل الباقي غدًا.'];
  for (const p of PROJECTS) {
    const project = await prisma.workProject.create({
      data: {
        companyId, key: p.key, name: p.name, description: `مشروع ${p.name} — ضمن خطة النمو لهذا العام.`, status: p.status, color: p.color, category: p.category,
        leadId: U[p.lead], startDate: new Date(now + p.start * DAY), dueDate: new Date(now + p.due * DAY), budget: p.budget, spent: p.spent,
        taskSeq: p.tasks.length, createdBy: U.owner, createdAt: new Date(now + p.start * DAY),
      },
    });
    for (const k of p.members) await prisma.workProjectMember.create({ data: { companyId, projectId: project.id, userId: U[k] } });
    for (const [title, d, done] of p.milestones) {
      await prisma.workMilestone.create({ data: { companyId, projectId: project.id, title, date: new Date(now + d * DAY), done } });
    }
    const pos: Record<number, number> = {};
    for (const [i, [title, status, priority, who]] of p.tasks.entries()) {
      pos[status] = (pos[status] ?? 0) + 1;
      const created = new Date(now + (p.start + i * 3) * DAY);
      const task = await prisma.workTask.create({
        data: {
          companyId, projectId: project.id, number: i + 1, title, description: `${title} ضمن مشروع «${p.name}».`, status, priority,
          assigneeId: U[who], labels: [pick(LABELS)], startDate: created, dueDate: new Date(created.getTime() + int(5, 20) * DAY),
          points: pick([1, 2, 3, 5, 8]), position: pos[status], createdBy: U[p.lead], createdAt: created,
          ...(status === 4 ? { completedAt: new Date(created.getTime() + int(3, 12) * DAY) } : {}),
        },
      });
      if (i % 3 === 0) {
        await prisma.workTaskComment.create({ data: { companyId, taskId: task.id, authorId: U[who], body: pick(COMMENTS), createdAt: new Date(created.getTime() + DAY) } });
      }
      await prisma.auditLog.create({
        data: {
          syncId: randomUUID(), companyId, actorId: U[p.lead], action: 'task.created', entityType: 'task', entityId: task.id,
          description: `أنشأ المهمة ${p.key}-${i + 1} «${title}»`, newValue: { projectId: project.id }, createdAt: created,
        },
      });
      if (status === 4) {
        await prisma.auditLog.create({
          data: {
            syncId: randomUUID(), companyId, actorId: U[who], action: 'task.status', entityType: 'task', entityId: task.id,
            description: `نقل ${p.key}-${i + 1} «${title}» إلى «مكتمل»`, newValue: { projectId: project.id }, createdAt: new Date(created.getTime() + 5 * DAY),
          },
        });
      }
    }
  }

  const NOTES = [
    ['assign', 'أُسندت إليك مهمة جديدة', 'WEB-6 «اختبار مسار الطلب من الجوال»', '/projects', 0.1],
    ['comment', 'تعليق جديد من سارة القحطاني', '«ممتاز — نعتمدها بعد تعديل بسيط على الألوان.»', '/projects', 0.3],
    ['milestone', 'اقترب موعد مرحلة «ربط الدفع والتوصيل»', 'متبقٍّ ٨ أيام على الموعد', '/projects', 1],
    ['billing', 'فاتورة متأخرة', 'INV-2026-0021 تجاوزت موعد استحقاقها', '/invoices', 2],
    ['system', 'طلب جديد في المتجر', 'طلب بقيمة ٣٨٥ ر.س من الرياض', '/orders', 0.05],
    ['system', 'مخزون منخفض', 'عسل سدر ملكي — بقيت ٣ قطع', '/inventory', 0.6],
    ['comment', 'تقييم جديد في المتجر', '٥ نجوم على «بن حرازي محمّص»', '/reviews', 3],
  ] as const;
  for (const [i, [kind, title, body, link, days]] of NOTES.entries()) {
    await prisma.notification.create({
      data: { companyId, userId: U.owner, kind, title, body, link, actorId: U.sara, createdAt: new Date(now - days * DAY), ...(i > 3 ? { readAt: new Date(now - days * DAY + 3_600_000) } : {}) },
    });
  }

  // ─────────────── المتجر ───────────────
  const store = await prisma.shopStore.create({
    data: {
      companyId, slug: 'oasis-demo', name: 'بُن وعسل الواحة', sector: 'food', tagline: 'بن يمني مختار وعسل جبلي أصلي — يصلك طازجًا',
      about: 'نختار البن من مدرجات حراز وبني مطر، ونحمّصه أسبوعيًا بكميات صغيرة، ونجلب العسل من مناحل حضرموت مباشرة.',
      city: 'الرياض', address: 'الرياض — حي الملقا', whatsapp: '966551341301', hours: 'يوميًا من ٩ص إلى ١١م',
      logo: IMG('1509042239860-f550ce710b93', 400), banner: IMG('1447933601403-0c6688de566e', 1600), showcase: IMG('1495474472287-4d71bcdd2085', 1200),
      color: '#6B3E26', colorDeep: '#4A2A19', template: 'essential', country: 'SA', verified: true,
      deliveryFee: 25, deliveryFreeOver: 250, deliveryNote: 'التوصيل خلال ٢٤–٤٨ ساعة داخل المدن الرئيسية', payMethods: 'cod,bank,wallet',
      payNote: 'حوّل إلى حساب مؤسسة الواحة — مصرف الراجحي (للعرض فقط)', createdAt: ago(120),
    },
  });
  const storeId = store.id;
  await prisma.storeSubscription.create({
    data: { syncId: randomUUID(), companyId, storeRef: storeId, storeName: store.name, plan: 2, status: 0, currentPeriodEnd: new Date(now + 5 * 365 * DAY) },
  });

  const cats: Record<string, string> = {};
  for (const [i, name] of ['البن', 'العسل', 'أدوات القهوة', 'الهدايا'].entries()) {
    cats[name] = (await prisma.shopCategory.create({ data: { companyId, storeId, name, sort: i } })).id;
  }
  const PRODUCTS: [string, string, string, number, number | null, number, string][] = [
    ['بن حرازي محمّص', 'البن', 'أرابيكا من مدرجات حراز بتحميص متوسط ونكهة الشوكولاتة.', 85, null, 64, '1559056199-641a0ac8b55e'],
    ['بن خولاني', 'البن', 'حبوب خولانية كاملة بحموضة متوازنة ونهاية طويلة.', 95, 110, 40, '1497935586351-b67a49e012bf'],
    ['بن مطري', 'البن', 'من بني مطر — نكهة فاكهة وحلاوة طبيعية.', 90, null, 35, '1611854779393-1b2da9d400fe'],
    ['قشر بن يمني', 'البن', 'للقهوة اليمنية التقليدية بالزنجبيل والقرفة.', 45, null, 80, '1447933601403-0c6688de566e'],
    ['عسل سدر حضرمي', 'العسل', 'عسل سدر أصلي من الموسم الأخير — كيلو.', 320, 360, 18, '1587049352846-4a222e784d38'],
    ['عسل سدر ملكي', 'العسل', 'أجود أنواع السدر من وادي دوعن — نصف كيلو.', 450, null, 3, '1558642452-9d2a7deb7f62'],
    ['عسل سمر جبلي', 'العسل', 'عسل جبلي داكن بطعم قوي وقوام كثيف.', 210, null, 22, '1471943311424-646960669fbc'],
    ['دلة نحاسية', 'أدوات القهوة', 'دلة يدوية مطروقة لتقديم القهوة العربية.', 145, null, 12, '1495474472287-4d71bcdd2085'],
    ['مطحنة يدوية', 'أدوات القهوة', 'مطحنة بتروس سيراميك وضبط دقيق للخشونة.', 120, 150, 4, '1442512595331-e89e73853f31'],
    ['فناجين فخارية (طقم ٦)', 'أدوات القهوة', 'فناجين مصنوعة يدويًا بلمسة تراثية.', 75, null, 30, '1514432324607-a09d9b4aefdd'],
    ['صندوق هدية الواحة', 'الهدايا', 'بن حرازي وعسل سدر ودلة صغيرة في صندوق فاخر.', 395, 450, 15, '1513885535751-8b9238bd345a'],
    ['بطاقة إهداء', 'الهدايا', 'بطاقة إهداء رقمية بقيمة تختارها.', 100, null, 999, '1549465220-1a8b9238cd48'],
  ];
  const products: { id: string; name: string; price: number; variants: { id: string; v1: string; price: number }[] }[] = [];
  for (const [i, [name, cat, description, price, oldPrice, qty, img]] of PRODUCTS.entries()) {
    const withSizes = i === 0;
    const p = await prisma.shopProduct.create({
      data: {
        companyId, storeId, categoryId: cats[cat], name, summary: description.split('—')[0].trim(), description, brand: 'الواحة',
        price, oldPrice, qty, lowStock: 5, image: IMG(img), live: true, sort: i, hasVariants: withSizes, opt1Name: withSizes ? 'الوزن' : '',
        createdAt: ago(110 - i),
      },
    });
    const variants: { id: string; v1: string; price: number }[] = [];
    if (withSizes) {
      for (const [k, [v1, vp, vq]] of ([['٢٥٠ غرام', 85, 30], ['٥٠٠ غرام', 160, 22], ['كيلو', 300, 12]] as const).entries()) {
        const v = await prisma.shopProductVariant.create({ data: { companyId, storeId, productId: p.id, v1, price: vp, qty: vq, sku: `HRZ-${k + 1}`, sort: k } });
        variants.push({ id: v.id, v1, price: vp });
      }
    }
    products.push({ id: p.id, name, price, variants });
  }

  const ZONES = [['الرياض', 15, 200], ['جدة', 25, 250], ['الدمام والخبر', 25, 250], ['باقي المدن', 35, 300]] as const;
  const zones: { id: string; name: string; fee: number; freeOver: number }[] = [];
  for (const [i, [name, fee, freeOver]] of ZONES.entries()) {
    const z = await prisma.shopDeliveryZone.create({ data: { companyId, storeId, name, fee, freeOver, sort: i } });
    zones.push({ id: z.id, name, fee, freeOver });
  }

  const FIRST = ['محمد', 'أحمد', 'فهد', 'نورة', 'ريم', 'سلطان', 'لمى', 'عبدالرحمن', 'هيفاء', 'تركي', 'جود', 'ماجد', 'شهد', 'بدر', 'غادة', 'نايف', 'دانة', 'راشد', 'أمل', 'سعود'];
  const LAST = ['العتيبي', 'الشهري', 'الدوسري', 'الغامدي', 'الزهراني', 'المطيري', 'القرني', 'الحربي', 'السبيعي', 'العنزي'];
  const customers: { id: string; name: string; phone: string; zone: (typeof zones)[number] }[] = [];
  for (let i = 0; i < 32; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const phone = `9665${String(10000000 + i * 271_313).slice(0, 8)}`;
    const zone = zones[i % 7 === 0 ? 3 : i % 4 === 0 ? 1 : i % 5 === 0 ? 2 : 0];
    const c = await prisma.shopCustomer.create({
      data: { companyId, storeId, phone, name, address: `${zone.name} — حي ${pick(['النرجس', 'الروضة', 'الشاطئ', 'العليا', 'الصفا', 'الياسمين'])}`, firstAt: ago(int(30, 100)), lastAt: ago(int(0, 20)) },
    });
    customers.push({ id: c.id, name, phone, zone });
  }

  // طلبات ٤٥ يومًا باتجاه صاعد؛ الأقدم مكتملة غالبًا، والأحدث قيد التأكيد
  const doneItems: { orderId: string; itemId: string; productId: string; name: string; at: Date }[] = [];
  let refN = 0;
  const REF = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let d = 44; d >= 0; d--) {
    const count = Math.max(0, Math.round(1 + (44 - d) / 14 + (rnd() * 2 - 0.6)));
    for (let k = 0; k < count; k++) {
      const c = pick(customers);
      const at = ago(d, int(9, 22), int(0, 59));
      const lines = Array.from({ length: int(1, 3) }, () => {
        const p = products[Math.min(products.length - 1, Math.floor(rnd() ** 1.6 * products.length))];
        const v = p.variants.length ? pick(p.variants) : null;
        return { p, v, qty: int(1, 3), price: v?.price ?? p.price };
      });
      const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
      const deliveryFee = subtotal >= c.zone.freeOver ? 0 : c.zone.fee;
      const status = d <= 1 ? pick([0, 0, 1]) : d <= 4 ? pick([1, 1, 2]) : pick([2, 2, 2, 2, 2, 2, 3]);
      const payMethod = pick(['cod', 'cod', 'bank', 'wallet']);
      const payStatus = payMethod === 'cod' ? 0 : status === 2 ? 3 : status === 3 ? 1 : pick([2, 3]);
      refN++;
      let ref = 'RS-';
      for (let r = 0, x = refN * 7919 + 104729; r < 5; r++, x = Math.floor(x / REF.length) + r * 31) ref += REF[x % REF.length];
      const order = await prisma.shopOrder.create({
        data: {
          companyId, storeId, ref, customerId: c.id, zoneId: c.zone.id, zoneName: c.zone.name, payMethod, payStatus, custName: c.name, custPhone: c.phone,
          custAddress: `${c.zone.name} — ${pick(['حي النرجس', 'حي الروضة', 'حي العليا', 'حي الصفا'])}`, note: k === 0 && d % 6 === 0 ? 'الرجاء الاتصال قبل التوصيل' : '',
          subtotal, deliveryFee, total: subtotal + deliveryFee, status, createdAt: at, updatedAt: new Date(at.getTime() + 6 * 3_600_000),
        },
      });
      for (const l of lines) {
        const item = await prisma.shopOrderItem.create({
          data: { companyId, storeId, orderId: order.id, productId: l.p.id, variantId: l.v?.id ?? null, name: l.p.name, variant: l.v?.v1 ?? '', price: l.price, qty: l.qty },
        });
        if (status === 2) doneItems.push({ orderId: order.id, itemId: item.id, productId: l.p.id, name: c.name, at });
      }
    }
  }

  const REVIEWS: [number, string, string][] = [
    [5, 'أفضل بن جربته — رائحته تملأ البيت. سأطلب مجددًا.', 'شكرًا لك! سعداء أنه أعجبك.'],
    [5, 'العسل أصلي ١٠٠٪ والتغليف ممتاز.', ''],
    [4, 'الجودة عالية والتوصيل تأخر يومًا.', 'نعتذر عن التأخير — حسّنّا مواعيد الشحن لمنطقتك.'],
    [5, 'الدلة جميلة جدًا وتصلح هدية.', ''],
    [5, 'تحميص متوازن وطعم نظيف.', 'شكرًا على ذوقك الرفيع ☕'],
    [4, 'طعم ممتاز، أتمنى توفير أحجام أكبر.', 'وفّرنا حجم الكيلو — متاح الآن.'],
    [5, 'صندوق الهدية فاخر وأسعد صاحبه.', ''],
    [5, 'تعامل راقٍ وسرعة في الرد.', ''],
    [3, 'المنتج جيد لكن الطحن كان أنعم مما أفضّل.', 'يمكنك اختيار حبوب كاملة في طلبك القادم.'],
    [5, 'عسل السمر قوي ولذيذ.', ''],
    [5, 'قهوة يومي من الواحة — لا أغيّرها.', ''],
    [4, 'جيد جدًا ويستحق التجربة.', ''],
  ];
  const seen = new Set<string>();
  let r = 0;
  for (const it of doneItems) {
    if (r >= REVIEWS.length || seen.has(it.itemId) || rnd() < 0.55) continue;
    seen.add(it.itemId);
    const [rating, body, reply] = REVIEWS[r++];
    await prisma.shopReview.create({
      data: {
        syncId: randomUUID(), companyId, storeId, productId: it.productId, orderId: it.orderId, orderItemId: it.itemId,
        rating, name: it.name.split(' ')[0], body, reply, status: 1, createdAt: new Date(it.at.getTime() + 3 * DAY),
      },
    });
  }

  for (let d = 44; d >= 0; d--) {
    await prisma.shopVisit.create({ data: { companyId, storeId, day: ymd(ago(d)), count: Math.round(40 + (44 - d) * 2.4 + rnd() * 35) } });
  }

  const orders = await prisma.shopOrder.count({ where: { storeId } });
  console.log(`شركة العرض جاهزة: ${org.name} (${companyId})`);
  console.log(`فريق ${TEAM.length} · عملاء ${clients.length} · فواتير ${STATUSES.length} · اجتماعات ${MEETINGS.length} · مشاريع ${PROJECTS.length}`);
  console.log(`المتجر /${store.slug}: منتجات ${products.length} · طلبات ${orders} · تقييمات ${r}`);
  console.log('الدخول: POST /api/v1/auth/demo (للقراءة فقط)');
}

/** يبني شركة العرض من الصفر (يحذف القديمة أولًا). */
export async function seedDemo(): Promise<void> {
  prisma = new PrismaClient();
  try {
    await main();
  } finally {
    await prisma.$disconnect();
  }
}

/** العمر الذي يُعاد بعده بناء العرض تلقائيًا — التواريخ نسبية، فالقديم تبهت رسومه */
const STALE_DAYS = 60;

/**
 * هل يحتاج العرض بناءً؟ غائب، أو أقدم من ٦٠ يومًا. يستدعيه الخادم عند الإقلاع
 * (`DEMO_AUTOSEED=0` يعطّله) فلا يحتاج النشر خطوة يدوية — ولا Shell في خطة Render المجانية.
 */
export async function demoNeedsSeed(): Promise<boolean> {
  const db = new PrismaClient();
  try {
    const org = await db.organization.findUnique({ where: { workspaceSlug: DEMO_WORKSPACE_SLUG }, select: { createdAt: true } });
    return !org || org.createdAt.getTime() < Date.now() - STALE_DAYS * DAY;
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  seedDemo().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
