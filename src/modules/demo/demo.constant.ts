/**
 * شركة العرض التجريبي المحجوزة — يدخلها أي زائر من صفحة «جرّب العرض» في AzmSmart
 * ليرى لوحة التحكم كاملة ببيانات واقعية. تُملأ بـ`scripts/seed-demo.ts`.
 *
 * للقراءة فقط: الحارس يرفض كل طلب كتابة فيها (`TenantGuard`)، فلا يعبث زائر
 * ببياناتها ولا يرفع إليها ملفات، ولا تحتاج إعادة ضبط دورية.
 */
export const DEMO_WORKSPACE_SLUG = 'rvios-demo';
export const DEMO_EMAIL = 'demo@azmsmart.demo';
export const DEMO_SESSION = '2h';
export const DEMO_READONLY =
  'هذا حساب عرض للمشاهدة فقط — أنشئ حسابك المجاني لتضيف وتعدّل بياناتك';
