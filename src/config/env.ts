/**
 * فحص البيئة عند الإقلاع — قبل أن يُنشأ أي اتصال.
 *
 * في التطوير والاختبارات لا يُفرض شيء (القيم الافتراضية تكفي). في الإنتاج
 * يرفض الخادم أن يقلع بإعداد ناقص بدل أن يعمل بقيم تطوير منسيّة: سرّ JWT
 * مثال، أو صور تُكتب على قرص حاوية تُمحى مع كل نشر، أو CORS مفتوح للتطوير.
 */

const R2_KEYS = ['CF_ACCOUNT_ID', 'CF_ACCESS_KEY_ID', 'CF_SECRET_ACCESS_KEY', 'CF_BUCKET_NAME', 'CF_PUBLIC_URL'] as const;

const WEAK_SECRETS = ['change-me-in-production', 'secret', 'test-secret-test-secret-test-secret-12'];

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return { errors, warnings };

  const need = (k: string, why: string) => {
    if (!env[k]?.trim()) errors.push(`${k} مطلوب — ${why}`);
  };

  need('DATABASE_URL', 'رابط PostgreSQL');
  need('JWT_SECRET', 'سرّ توقيع الجلسات');
  const secret = env.JWT_SECRET ?? '';
  if (secret && (secret.length < 32 || WEAK_SECRETS.includes(secret))) {
    errors.push('JWT_SECRET ضعيف — ٣٢ حرفًا عشوائيًا على الأقل (انظر .env.example)');
  }

  need('CORS_ORIGINS', 'أصول الواجهات المسموح لها، مثل https://azm.rvios.com,https://*.rvios.store');
  if ((env.CORS_ORIGINS ?? '').includes('localhost')) warnings.push('CORS_ORIGINS فيه localhost — أصل تطوير في إعداد إنتاج');

  need('PUBLIC_API_URL', 'العنوان العام للخادم (تُبنى منه روابط الملفات المحلية)');
  if (env.PUBLIC_API_URL && !env.PUBLIC_API_URL.startsWith('https://')) warnings.push('PUBLIC_API_URL ليس https');

  need('VISIT_SALT', 'ملح ثابت لعدّ الزيارات دون تخزين عناوين الزوّار');

  const r2 = R2_KEYS.filter((k) => env[k]?.trim());
  if (env.STORAGE_DRIVER === 'local') {
    warnings.push('STORAGE_DRIVER=local — الصور على قرص الخادم: اربط UPLOAD_DIR بمجلد دائم وإلا ضاعت مع كل نشر');
  } else if (r2.length !== R2_KEYS.length) {
    errors.push(`تخزين R2 ناقص (${R2_KEYS.filter((k) => !env[k]?.trim()).join('، ')}) — أكمله، أو اضبط STORAGE_DRIVER=local مع مجلد دائم`);
  }

  if (env.WEBHOOK_ALLOW_PRIVATE === '1') errors.push('WEBHOOK_ALLOW_PRIVATE=1 للتطوير فقط — يفتح الخطافات على الشبكة الداخلية');

  const channels = (env.NOTIFY_CHANNELS ?? 'console').split(',').map((c) => c.trim());
  if (channels.includes('whatsapp') && (!env.META_TOKEN || !env.WA_PHONE_ID)) {
    errors.push('NOTIFY_CHANNELS فيه whatsapp دون META_TOKEN و WA_PHONE_ID');
  }
  if (!channels.includes('whatsapp')) warnings.push('إشعارات التجّار على console فقط — أضف whatsapp إلى NOTIFY_CHANNELS بعد إعداد Meta');

  return { errors, warnings };
}

/** يطبع التحذيرات، ويوقف الإقلاع إن وُجدت أخطاء. */
export function assertEnv(): void {
  const { errors, warnings } = checkEnv();
  for (const w of warnings) console.warn(`[env] تحذير: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[env] خطأ: ${e}`);
    console.error('[env] أُوقف الإقلاع — أصلح متغيّرات البيئة أعلاه.');
    process.exit(1);
  }
}

/**
 * أصول CORS: قائمة صريحة مع دعم `*.` للنطاقات الفرعية
 * (`https://*.rvios.store` يطابق `https://noir.rvios.store`).
 */
export function originMatcher(list: string): (origin: string) => boolean {
  const entries = list.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const exact = new Set(entries.filter((o) => !o.includes('*')));
  const wild = entries
    .filter((o) => o.includes('://*.'))
    .map((o) => {
      const [scheme, host] = o.split('://*.');
      return { prefix: `${scheme}://`, suffix: `.${host}` };
    });
  return (origin) =>
    exact.has(origin) ||
    wild.some((w) => origin.startsWith(w.prefix) && origin.endsWith(w.suffix) && !origin.slice(w.prefix.length, -w.suffix.length).includes('/'));
}
