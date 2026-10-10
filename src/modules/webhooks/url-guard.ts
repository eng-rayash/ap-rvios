import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * حماية من SSRF: عنوان الخطاف يكتبه التاجر، وخادمنا هو من يرسل إليه. بلا
 * هذا الفحص يستطيع أي تاجر أن يجعل خادمنا يطرق عناوين داخلية (قاعدة
 * البيانات، خدمات السحابة الوصفية `169.254.169.254`…) ويقرأ ردودها من سجل
 * الإرسال.
 *
 * `WEBHOOK_ALLOW_PRIVATE=1` للتطوير والاختبارات فقط (مستقبِل على
 * `localhost`) — ويسمح حينها بـ`http`. في غيابه: `https` وعناوين عامة فقط.
 *
 * يُعاد الفحص عند كل إرسال لا عند الحفظ وحده: اسم نطاق كان يشير إلى عنوان
 * عام قد يُغيَّر لاحقًا ليشير إلى عنوان داخلي. تبقى نافذة ضيقة بين الفحص
 * والاتصال (إعادة الربط السريع لـDNS)، والتحويلات مُعطَّلة عند الإرسال كي
 * لا تكون طريقًا ثانيًا للالتفاف.
 */
export function allowPrivateTargets(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE === '1';
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('ff')
    );
  }
  return true;
}

/** يرفض أي عنوان لا يصلح هدفًا لإرسال خطاف. يرمي خطأ ٤٠٠ برسالة عربية. */
export async function assertDeliverableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('عنوان غير صالح');
  }

  const allowPrivate = allowPrivateTargets();
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new BadRequestException('يجب أن يبدأ العنوان بـ https://');
  }
  if (url.username || url.password) {
    throw new BadRequestException('لا تضع اسم مستخدم أو كلمة مرور داخل العنوان');
  }
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new BadRequestException('تعذّر الوصول إلى هذا النطاق');
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new BadRequestException('لا يُسمح بعناوين داخلية أو محلية');
  }
  return url;
}
