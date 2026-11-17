import { SetMetadata } from '@nestjs/common';

import { TenantContext, UserRole } from './tenant-context';

/**
 * أقسام المتجر التي يُحدَّد بها ما يراه الموظف — فوق الدور لا بدلًا منه: الدور يقرّر «هل يكتب»،
 * والقسم يقرّر «أين». المدير فما فوق يرى كل شيء دائمًا. العضوية بلا قائمة = كل الأقسام
 * (سلوك ما قبل الميزة، فلا يفقد موظف قائم شيئًا).
 */
export const SHOP_SECTIONS = ['orders', 'products', 'customers', 'marketing', 'reports'] as const;
export type ShopSectionKey = (typeof SHOP_SECTIONS)[number];

export const SHOP_SECTION_LABEL: Record<ShopSectionKey, string> = {
  orders: 'الطلبات',
  products: 'المنتجات',
  customers: 'العملاء',
  marketing: 'التسويق',
  reports: 'التقارير والأرباح',
};

export const SHOP_SECTION_KEY = 'azm:shopSection';
/** يقصر المسار على من يملك هذا القسم */
export const ShopSection = (s: ShopSectionKey) => SetMetadata(SHOP_SECTION_KEY, s);

/** أقسام العضوية — null يعني كلها */
export function sectionsOf(role: number, permissions: unknown): ShopSectionKey[] | null {
  if (role <= UserRole.Admin) return null;
  const list = (permissions as { shop?: unknown } | null)?.shop;
  if (!Array.isArray(list)) return null;
  return SHOP_SECTIONS.filter((s) => list.includes(s));
}

export const canSee = (ctx: TenantContext, s: ShopSectionKey) => !ctx.sections || ctx.sections.includes(s);

const COST_KEYS = new Set(['costPrice', 'cost', 'profit']);

/** يحذف التكلفة والربح من الرد لمن لا يملك «التقارير والأرباح» */
export function hideCost<T>(ctx: TenantContext, value: T): T {
  if (canSee(ctx, 'reports')) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !COST_KEYS.has(k)).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
