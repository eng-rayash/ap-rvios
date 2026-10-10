/**
 * النطاق الخاص لمتجر — يُخزَّن بلا بروتوكول ولا مسار ولا `www.`، بأحرف صغيرة،
 * فيطابق ترويسة `Host` كما يرسلها المتصفح أيًّا كانت صيغة إدخال التاجر.
 */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** نطاقات المنصة نفسها — لا يأخذها متجر نطاقًا خاصًّا */
const RESERVED = ['rvios.store', 'rvios.com', 'localhost'];

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

/** سبب الرفض، أو `null` إن كان النطاق صالحًا */
export function domainProblem(domain: string): string | null {
  if (!HOST.test(domain)) return 'نطاق غير صالح — مثال: mystore.com';
  if (RESERVED.some((r) => domain === r || domain.endsWith(`.${r}`))) return 'هذا من نطاقات المنصة — استعمل نطاقك الخاص';
  return null;
}
