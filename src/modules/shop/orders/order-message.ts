import { ShopOrder, ShopOrderItem, ShopStore } from '@prisma/client';

import { PAY_METHODS, symbolOf } from '../shop.constants';

const PAY_LABEL: Record<string, string> = Object.fromEntries(
  Object.values(PAY_METHODS).map((m) => [m.id, m.label]),
);

/**
 * رسالة واتساب المنسّقة.
 *
 * الأرقام لاتينية عمدًا بينما الواجهة عربية-هندية: التاجر ينسخ هذه الرسالة
 * ويحسب عليها ويعيد إرسالها، والأرقام اللاتينية أسلم في النسخ واللصق عبر
 * التطبيقات. الاتساق البصري مكانه الواجهة لا رسالة تشغيلية.
 */
export function orderMessage(
  store: Pick<ShopStore, 'name' | 'country'>,
  order: ShopOrder & { items: ShopOrderItem[] },
): string {
  const money = (n: number) => Number(n || 0).toLocaleString('en-US');
  // العملة من دولة المتجر لا مكتوبة بالقيمة
  const cur = symbolOf(store.country);

  const lines = order.items
    .map(
      (l) =>
        `• ${l.name}${l.variant ? ` (${l.variant})` : ''} × ${l.qty} — ${money(l.price * l.qty)} ${cur}`,
    )
    .join('\n');

  const parts = [
    `مرحبًا، أود تأكيد طلبي من ${store.name}`,
    '',
    `رقم الطلب: ${order.ref}`,
    '',
    lines,
    '',
  ];

  // يُفصَّل التوصيل فقط حين يكون له رسوم أو منطقة
  if (order.deliveryFee > 0) {
    parts.push(`المجموع: ${money(order.subtotal)} ${cur}`);
    parts.push(
      `التوصيل${order.zoneName ? ` (${order.zoneName})` : ''}: ${money(order.deliveryFee)} ${cur}`,
    );
  } else if (order.zoneName) {
    parts.push(`المجموع: ${money(order.subtotal)} ${cur}`);
    parts.push(`التوصيل (${order.zoneName}): مجاني`);
  }
  parts.push(`الإجمالي: ${money(order.total)} ${cur}`);

  // طريقة الدفع تُذكر دائمًا — هي أول ما يسأل عنه التاجر
  parts.push('', `الدفع: ${PAY_LABEL[order.payMethod] ?? 'عند الاستلام'}`);
  if (order.custAddress) parts.push('', `العنوان: ${order.custAddress}`);
  if (order.note) parts.push('', `ملاحظة: ${order.note}`);
  parts.push('', '(طلب مسجّل عبر RVIOS Store)');

  return parts.join('\n');
}

export function waLink(
  store: Pick<ShopStore, 'name' | 'country' | 'whatsapp'>,
  order: ShopOrder & { items: ShopOrderItem[] },
): string {
  return `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(orderMessage(store, order))}`;
}

/** رابط استفسار عن منتج واحد. */
export function waAsk(
  store: Pick<ShopStore, 'whatsapp'>,
  product: { name: string; variant: string },
): string {
  const text = `مرحبًا، أود الاستفسار عن: ${product.name}${product.variant ? ` (${product.variant})` : ''}`;
  return `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(text)}`;
}
