import { Prisma } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** ما يرسله المتجر مع الزيارة — الصفحة ومصدر الدخول (اسم موقع فقط، لا رابط كامل) */
export class VisitDto {
  @IsOptional() @IsString() @MaxLength(300) path?: string;
  @IsOptional() @IsString() @MaxLength(300) ref?: string;
}

/** زواحف ومعاينات الروابط — لا تُعدّ زوّارًا */
export const isBot = (ua: string) => /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse/i.test(ua);

export function deviceOf(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** مسار الصفحة داخل المتجر بلا استعلام ولا ما يُعرّف أحدًا — والطول محدود */
export function cleanPath(p?: string): string {
  const raw = (p ?? '/').split(/[?#]/)[0].toLowerCase();
  const path = `/${raw.replace(/[^a-z0-9/_-]/g, '').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')}`;
  // رقم الطلب في صفحة التتبّع لا يُخزَّن: الصفحة نفسها لكل الطلبات
  return (path.startsWith('/order/') ? '/order' : path).slice(0, 80) || '/';
}

const SOURCES: [RegExp, string][] = [
  [/(^|\.)google\./, 'google'],
  [/(^|\.)(facebook|fb)\.(com|me)$|^m\.facebook|^l\.facebook/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)snapchat\.com$/, 'snapchat'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'x'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)(telegram\.org|t\.me)$/, 'telegram'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'youtube'],
  [/(^|\.)bing\.com$/, 'bing'],
];

/** مصدر الزيارة من اسم الموقع المحيل: مباشر، أو شبكة معروفة، أو اسم الموقع */
export function sourceOf(ref: string | undefined, ownHosts: string[]): string {
  let host = (ref ?? '').trim().toLowerCase();
  try {
    if (host.includes('/')) host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    host = '';
  }
  host = host.replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').slice(0, 60);
  if (!host || ownHosts.some((h) => host === h || host.endsWith(`.${h}`))) return 'direct';
  // تطبيق أندرويد يُحيل باسم حزمته
  if (host.startsWith('com.whatsapp')) return 'whatsapp';
  for (const [re, name] of SOURCES) if (re.test(host)) return name;
  return host;
}

/** فرق التوقيت لساعة الذروة بحسب بلد المتجر — الأيام نفسها تبقى بتوقيت UTC كبقية التقارير */
const TZ: Record<string, number> = { YE: 3, SA: 3, KW: 3, QA: 3, BH: 3, IQ: 3, JO: 3, SY: 3, AE: 4, OM: 4, EG: 2, SD: 2, LY: 2, PS: 2, LB: 2, MA: 1, DZ: 1, TN: 1 };
export const localHour = (country: string, at = new Date()) => (at.getUTCHours() + (TZ[country] ?? 3) + 24) % 24;

export type StatRow = { dim: string; key: string };

export const statUpsert = (
  tx: Prisma.TransactionClient,
  store: { id: string; companyId: string },
  day: string,
  r: StatRow,
) =>
  tx.shopVisitStat.upsert({
    where: { storeId_day_dim_key: { storeId: store.id, day, dim: r.dim, key: r.key } },
    create: { companyId: store.companyId, storeId: store.id, day, dim: r.dim, key: r.key, count: 1 },
    update: { count: { increment: 1 } },
  });
