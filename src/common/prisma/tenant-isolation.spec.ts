import { TenantPrismaService } from './tenant-prisma.service';
import {
  UserRole,
  hasRole,
  canManageMembers,
  hasHrAccess,
  hasFinanceAccess,
} from '../tenant/tenant-context';

/**
 * عزل المستأجر — بوّابة المرحلة ٣.
 *
 * التسريب بين الشركات هو الخطر الأعلى في أي نظام متعدّد المستأجرين:
 * لا يفشل شيء، ولا يرمي استثناء، ولا يكسر اختبارًا. يظهر حين يشتكي
 * عميل أنه يرى بيانات غيره — وعندها يكون الضرر وقع.
 *
 * هذه الاختبارات تحرس القواعد التي تمنعه.
 */
describe('حارس المستأجر', () => {
  describe('رفض السياق الفارغ', () => {
    it('forTenant يرمي على معرّف فارغ', () => {
      const svc = new TenantPrismaService();
      // لو مُرّر `undefined` إلى Prisma لتجاهل المرشّح وأعاد كل الصفوف:
      // فشل صريح خير من استعلام بلا قيد.
      expect(() => svc.forTenant('')).toThrow(/companyId/);
      expect(() => svc.forTenant(undefined as unknown as string)).toThrow();
    });
  });
});

/**
 * هرم الأدوار.
 *
 * الأرقام عقد تخزين مشترك مع العميل: صفوف `memberships` تحمل الرقم لا
 * الاسم، والعميل يقرأها بـ`UserRole` في `enums.dart`. أي انحراف بين
 * الطرفين يعيد تفسير عضويات قائمة — موظف يصير مالكًا.
 */
describe('الأدوار', () => {
  it('الترقيم يطابق العميل', () => {
    expect(UserRole.Owner).toBe(0);
    expect(UserRole.SuperAdmin).toBe(1);
    expect(UserRole.Admin).toBe(2);
    expect(UserRole.Executive).toBe(3);
    expect(UserRole.HrManager).toBe(4);
    expect(UserRole.FinanceManager).toBe(5);
    expect(UserRole.DeptManager).toBe(6);
    expect(UserRole.TeamLeader).toBe(7);
    expect(UserRole.Employee).toBe(8);
    expect(UserRole.Guest).toBe(9);
  });

  describe('hasRole — الأصغر أعلى', () => {
    it('المالك يملك كل صلاحية', () => {
      expect(hasRole(UserRole.Owner, UserRole.Admin)).toBe(true);
      expect(hasRole(UserRole.Owner, UserRole.Guest)).toBe(true);
    });

    it('الموظف لا يملك صلاحية المدير', () => {
      expect(hasRole(UserRole.Employee, UserRole.Admin)).toBe(false);
    });

    it('الدور يملك صلاحية نفسه', () => {
      expect(hasRole(UserRole.Admin, UserRole.Admin)).toBe(true);
    });
  });

  describe('إدارة الأعضاء', () => {
    it('حتى المدير وما فوقه', () => {
      expect(canManageMembers(UserRole.Owner)).toBe(true);
      expect(canManageMembers(UserRole.SuperAdmin)).toBe(true);
      expect(canManageMembers(UserRole.Admin)).toBe(true);
    });

    it('المدير التنفيذي فما دون لا', () => {
      expect(canManageMembers(UserRole.Executive)).toBe(false);
      expect(canManageMembers(UserRole.Employee)).toBe(false);
    });
  });

  describe('الموارد البشرية', () => {
    it('حتى مدير الموارد البشرية', () => {
      expect(hasHrAccess(UserRole.HrManager)).toBe(true);
      expect(hasHrAccess(UserRole.Executive)).toBe(true);
    });

    it('المدير المالي فما دون لا', () => {
      expect(hasHrAccess(UserRole.FinanceManager)).toBe(false);
      expect(hasHrAccess(UserRole.Employee)).toBe(false);
    });
  });

  describe('المالية', () => {
    it('حتى المدير المالي', () => {
      expect(hasFinanceAccess(UserRole.FinanceManager)).toBe(true);
      expect(hasFinanceAccess(UserRole.Owner)).toBe(true);
    });

    it('مدير الموارد البشرية مستثنى رغم أن رقمه أصغر', () => {
      // الحالة الوحيدة التي ينكسر فيها الترتيب الهرمي، ولها سبب:
      // الرواتب ليست مبرّرًا للاطّلاع على الفواتير ودفاتر الحسابات.
      expect(hasFinanceAccess(UserRole.HrManager)).toBe(false);
      expect(UserRole.HrManager).toBeLessThan(UserRole.FinanceManager);
    });

    it('مدير القسم فما دون لا', () => {
      expect(hasFinanceAccess(UserRole.DeptManager)).toBe(false);
      expect(hasFinanceAccess(UserRole.Guest)).toBe(false);
    });
  });
});
