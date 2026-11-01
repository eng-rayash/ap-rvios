import { UnauthorizedException } from '@nestjs/common';
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
/** تُعاد مفاتيح Google دوريًا — ساعة تكفي، ومفتاح مجهول يفرض جلبًا جديدًا */
const CERTS_TTL = 60 * 60_000;
/** تسامح فرق الساعات بين الخادمين */
const CLOCK_SKEW_S = 60;

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

type Jwk = JsonWebKey & { kid: string };
let certs: { at: number; keys: Jwk[] } | null = null;

async function loadCerts(force: boolean): Promise<Jwk[]> {
  if (!force && certs && Date.now() - certs.at < CERTS_TTL) return certs.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new UnauthorizedException('تعذّر التحقق من حساب Google — حاول مجددًا');
  const { keys } = (await res.json()) as { keys: Jwk[] };
  certs = { at: Date.now(), keys };
  return keys;
}

const rejected = () => new UnauthorizedException('تعذّر التحقق من حساب Google');

/**
 * يتحقق من رمز هوية Google محليًا بمفاتيح Google العامة: التوقيع والمُصدر والجمهور
 * والصلاحية والبريد المؤكَّد — فلا تُقبل هوية أصدرها تطبيق غير تطبيقنا.
 */
export async function verifyGoogleIdToken(token: string, audience: string): Promise<GoogleIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw rejected();
  const [head, body, sig] = parts;

  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString());
    claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    throw rejected();
  }
  // RS256 حصرًا: لا يُترك للرمز نفسه أن يختار خوارزمية التحقق
  if (header.alg !== 'RS256' || !header.kid) throw rejected();

  let jwk = (await loadCerts(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await loadCerts(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw rejected();

  const ok = createVerify('RSA-SHA256')
    .update(`${head}.${body}`)
    .verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw rejected();

  const now = Date.now() / 1000;
  if (claims.aud !== audience || !ISSUERS.has(String(claims.iss))) throw rejected();
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw rejected();
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') throw rejected();
  // بريد لم تؤكده Google لا يثبت الملكية
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw rejected();

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : claims.email.split('@')[0],
    picture: typeof claims.picture === 'string' ? claims.picture : null,
  };
}
