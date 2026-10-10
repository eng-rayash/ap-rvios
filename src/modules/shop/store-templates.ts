import { ShopPlan } from '../shop-billing/shop-billing.constants';

/**
 * قوالب واجهة منصة المتاجر (rvios-next) — المعرّفات وفئاتها وأسعارها الافتراضية.
 *
 * القائمة نفسها في الواجهة (`lib/catalog.ts` و`lib/catalog-cx.ts` هناك) لعرض
 * القوالب؛ وهنا للحكم: من يحقّ له أي قالب، وبكم. السعر الافتراضي بعملة
 * الفوترة، وتغيّره الإدارة من إعدادات المنصة بالمفتاح `tpl.<id>` دون نشر كود.
 *
 * قواعد الباقات (كما في صفحة الأسعار):
 *   المجانية  — القالب الأساسي وحده.
 *   الاحترافية — كل القوالب، والمدفوع منها يُشترى دفعة واحدة بسعره.
 *   الأعمال    — القياسية مجانًا، والتوقيع بخصم ٤٠٪.
 */
export type TemplateTier = 'free' | 'standard' | 'signature';

export const FREE_TEMPLATE = 'essential';

export const STORE_TEMPLATES: Record<string, { tier: TemplateTier; price: number }> = {
  essential: { tier: 'free', price: 0 },
  // التوقيع
  dahab: { tier: 'signature', price: 55 },
  noir: { tier: 'signature', price: 49 },
  maison: { tier: 'signature', price: 45 },
  volt: { tier: 'signature', price: 39 },
  khatwa: { tier: 'signature', price: 39 },
  satr: { tier: 'signature', price: 35 },
  nada: { tier: 'signature', price: 32 },
  // القياسية
  bayt: { tier: 'standard', price: 29 },
  qita: { tier: 'standard', price: 29 },
  nabd: { tier: 'standard', price: 27 },
  maida: { tier: 'standard', price: 25 },
  turath: { tier: 'standard', price: 24 },
  zahr: { tier: 'standard', price: 22 },
  sukkar: { tier: 'standard', price: 19 },
  asal: { tier: 'standard', price: 19 },
  marah: { tier: 'standard', price: 17 },
  waraq: { tier: 'standard', price: 15 },
};

/** خصم قوالب التوقيع في باقة الأعمال */
export const BIZ_SIGNATURE_RATE = 0.6;

export const isTemplate = (id: string) => Object.prototype.hasOwnProperty.call(STORE_TEMPLATES, id);

/**
 * سعر شراء القالب لمتجر على باقة بعينها، أو `0` إن كان متاحًا بلا شراء، أو
 * `null` إن كانت الباقة لا تسمح به أصلًا (المجانية مع قالب مدفوع).
 *
 * @param base السعر المعتمد (الافتراضي أو ما ضبطته الإدارة)
 */
export function templateCost(id: string, plan: ShopPlan, base: number): number | null {
  const t = STORE_TEMPLATES[id];
  if (!t || t.tier === 'free') return 0;
  if (plan === ShopPlan.Basic) return null;
  if (plan === ShopPlan.Pro) {
    if (t.tier === 'standard') return 0;
    return Math.round(base * BIZ_SIGNATURE_RATE);
  }
  return base;
}

/**
 * القالب الذي يُعرض فعلًا: المحفوظ إن كانت الباقة الحالية تسمح به (مملوك، أو
 * مجاني لهذه الباقة)، وإلا الأساسي — دون مسح المحفوظ، فيعود حين يعود حقّه
 * (إخفاء لا حذف، كالسكِنات).
 */
export function effectiveTemplate(saved: string, owned: string[], plan: ShopPlan): string {
  if (!isTemplate(saved)) return FREE_TEMPLATE;
  if (STORE_TEMPLATES[saved].tier === 'free') return saved;
  if (plan === ShopPlan.Basic) return FREE_TEMPLATE;
  if (owned.includes(saved)) return saved;
  return templateCost(saved, plan, 1) === 0 ? saved : FREE_TEMPLATE;
}

/** أدنى ما تحتاجه دوال الملكية من عميل Prisma (عميل الشركة أو الأساس) */
interface StoreTable {
  shopStore: {
    findFirst(args: { where: { id: string }; select: { ownedTemplates: true; template: true } }): Promise<{ ownedTemplates: string[]; template: string } | null>;
    update(args: { where: { id: string }; data: { ownedTemplates?: string[]; template?: string } }): Promise<unknown>;
  };
}

/**
 * يضيف القالب إلى ملكية المتجر ويجعله قالبه الحالي — عند رفع إيصال فاتورته
 * (تفعيل فوري كالباقات) أو عند تأكيدها يدويًا.
 */
export async function grantTemplate(db: StoreTable, storeId: string, templateId: string) {
  const s = await db.shopStore.findFirst({ where: { id: storeId }, select: { ownedTemplates: true, template: true } });
  if (!s) return;
  const owned = s.ownedTemplates.includes(templateId) ? s.ownedTemplates : [...s.ownedTemplates, templateId];
  await db.shopStore.update({ where: { id: storeId }, data: { ownedTemplates: owned, template: templateId } });
}

/** يسحب القالب حين يُرفض إيصال فاتورته — ويعيد المتجر إلى الأساسي إن كان يستعمله. */
export async function revokeTemplate(db: StoreTable, storeId: string, templateId: string) {
  const s = await db.shopStore.findFirst({ where: { id: storeId }, select: { ownedTemplates: true, template: true } });
  if (!s) return;
  await db.shopStore.update({
    where: { id: storeId },
    data: {
      ownedTemplates: s.ownedTemplates.filter((t) => t !== templateId),
      ...(s.template === templateId ? { template: FREE_TEMPLATE } : {}),
    },
  });
}
