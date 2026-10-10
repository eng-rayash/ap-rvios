import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'sk_live_';

/**
 * يولّد سرًّا عشوائيًا (١٩٢ بتة) وجزءًا معروضًا لا يكفي لانتحاله.
 *
 * مشتركة بين [ApiKeysService] (الإصدار) و[TenantGuard] (التحقّق) عمدًا:
 * خوارزمية التجزئة يجب أن تبقى واحدة في مكان واحد — لو كُتبت مرتين
 * وانحرفتا، لصار كل مفتاح صادر برمز لا يُقبل أبدًا، أو أسوأ، يُقبل خطأً.
 */
export function generateApiKey(): { secret: string; prefix: string } {
  const raw = randomBytes(24).toString('hex');
  return {
    secret: `${KEY_PREFIX}${raw}`,
    prefix: `${KEY_PREFIX}${raw.slice(0, 6)}…`,
  };
}

/** بصمة SHA-256 للسرّ — هذا وحده ما يُخزَّن، لا السرّ نفسه. */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
