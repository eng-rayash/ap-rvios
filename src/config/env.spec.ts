import { checkEnv, originMatcher } from './env';

const R2 = { CF_ACCOUNT_ID: 'a', CF_ACCESS_KEY_ID: 'b', CF_SECRET_ACCESS_KEY: 'c', CF_BUCKET_NAME: 'd', CF_PUBLIC_URL: 'https://cdn.x' };
const PROD = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(48),
  CORS_ORIGINS: 'https://azm.rvios.com', PUBLIC_API_URL: 'https://api.rvios.com', VISIT_SALT: 's', ...R2,
};

describe('checkEnv', () => {
  it('لا يفرض شيئًا خارج الإنتاج', () => {
    expect(checkEnv({ NODE_ENV: 'development' }).errors).toEqual([]);
  });

  it('يقبل إعداد إنتاج كاملًا', () => {
    expect(checkEnv(PROD).errors).toEqual([]);
  });

  it('يرفض سرّ JWT المثال أو القصير', () => {
    expect(checkEnv({ ...PROD, JWT_SECRET: 'change-me-in-production' }).errors.join()).toContain('JWT_SECRET');
    expect(checkEnv({ ...PROD, JWT_SECRET: 'short' }).errors.join()).toContain('JWT_SECRET');
  });

  it('يرفض R2 الناقص ما لم يُختر القرص المحلي صراحةً', () => {
    expect(checkEnv({ ...PROD, CF_SECRET_ACCESS_KEY: '' }).errors.join()).toContain('CF_SECRET_ACCESS_KEY');
    const local = checkEnv({ ...PROD, CF_SECRET_ACCESS_KEY: '', STORAGE_DRIVER: 'local' });
    expect(local.errors).toEqual([]);
    expect(local.warnings.join()).toContain('UPLOAD_DIR');
  });

  it('يرفض خطافات الشبكة الداخلية وواتساب بلا مفاتيح', () => {
    expect(checkEnv({ ...PROD, WEBHOOK_ALLOW_PRIVATE: '1' }).errors.join()).toContain('WEBHOOK_ALLOW_PRIVATE');
    expect(checkEnv({ ...PROD, NOTIFY_CHANNELS: 'whatsapp' }).errors.join()).toContain('META_TOKEN');
  });
});

describe('originMatcher', () => {
  const ok = originMatcher('https://azm.rvios.com, https://*.rvios.store,http://localhost:3001/');

  it('يطابق القائمة الصريحة', () => {
    expect(ok('https://azm.rvios.com')).toBe(true);
    expect(ok('http://localhost:3001')).toBe(true);
    expect(ok('https://evil.com')).toBe(false);
  });

  it('يطابق النطاقات الفرعية دون النطاق المقلَّد', () => {
    expect(ok('https://noir.rvios.store')).toBe(true);
    expect(ok('https://a.b.rvios.store')).toBe(true);
    expect(ok('https://rvios.store.evil.com')).toBe(false);
    expect(ok('https://evilrvios.store')).toBe(false);
    expect(ok('http://noir.rvios.store')).toBe(false);
  });
});
