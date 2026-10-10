/**
 * AZM — سياق المستأجر
 *
 * الشركة تُشتقّ من الجلسة، **ولا تُقبل من العميل أبدًا**.
 *
 * هذه القاعدة هي الفارق بين عزل حقيقي وعزل ظاهري: لو أخذنا
 * `companyId` من جسم الطلب أو من ترويسة، لأمكن لأي مستخدم تبديلها
 * وقراءة بيانات شركة أخرى. العميل يقول «من أنا»، والخادم يقرّر «ماذا
 * أرى».
 */

/** هوية الطالب كما حلّها الخادم من الرمز. */
export interface TenantContext {
  /** معرّف المستخدم — عالمي، لا يخصّ شركة */
  readonly userId: string;

  /** الشركة النشطة في هذه الجلسة */
  readonly companyId: string;

  /** دور المستخدم في هذه الشركة تحديدًا */
  readonly role: UserRole;

  /** معرّف العضوية — يربط المستخدم بالشركة */
  readonly membershipId: string;
}

/**
 * الأدوار — مطابقة لترقيم العميل في `enums.dart`.
 *
 * ⚠ الأرقام عقد تخزين مشترك بين الطرفين: صفوف `memberships` تحمل
 * الرقم لا الاسم. تغييره هنا يعيد تفسير عضويات قائمة.
 *
 * القيمة الأصغر = صلاحية أعلى. هذا الترتيب مقصود: فحص الصلاحية يصير
 * مقارنة واحدة (`role <= required`) بدل قائمة أدوار مسموحة تُنسى
 * إضافة دور جديد إليها.
 */
export enum UserRole {
  Owner = 0,
  SuperAdmin = 1,
  Admin = 2,
  Executive = 3,
  HrManager = 4,
  FinanceManager = 5,
  DeptManager = 6,
  TeamLeader = 7,
  Employee = 8,
  Guest = 9,
}

/** هل يملك [role] صلاحية [required] أو أعلى؟ */
export function hasRole(role: UserRole, required: UserRole): boolean {
  return role <= required;
}

/** هل يستطيع الدور إدارة الأعضاء؟ */
export function canManageMembers(role: UserRole): boolean {
  return hasRole(role, UserRole.Admin);
}

/** هل يملك الدور وصولًا إلى الموارد البشرية؟ */
export function hasHrAccess(role: UserRole): boolean {
  return hasRole(role, UserRole.HrManager);
}

/**
 * هل يملك الدور وصولًا إلى المالية؟
 *
 * مدير الموارد البشرية مستثنى رغم أن رقمه أصغر: الرواتب ليست مبرّرًا
 * للاطّلاع على الفواتير ودفاتر الحسابات. هذه الحالة الوحيدة التي
 * ينكسر فيها الترتيب الهرمي، ولها سبب لا استثناء عشوائي.
 */
export function hasFinanceAccess(role: UserRole): boolean {
  return hasRole(role, UserRole.FinanceManager) && role !== UserRole.HrManager;
}

/**
 * هوية موظّف منصة كما حلّها الخادم — عبر كل الشركات، لا داخل واحدة.
 *
 * نوع مختلف عن [TenantContext] عمدًا لا نسخة منه بحقل إضافي: خلطهما في
 * نوع واحد يفتح الباب لمسار يقرأ `companyId` توقّعًا فيصل بغلط إلى
 * `forTenant()`، بينما إدارة المنصة يجب ألا تُقيَّد بشركة أصلًا.
 */
export interface PlatformContext {
  readonly userId: string;
  /** 0=دعم · 1=فوترة · 2=مدير عام */
  readonly platformRole: number;
}
