# نشر منظومة RVIOS

أربعة تطبيقات فوق قاعدة واحدة. هذا الدليل يكفي لنشرها من الصفر.

| التطبيق | المجلد | النطاق المقترح | الاستضافة المقترحة |
|---|---|---|---|
| الباكند الموحّد (NestJS + Prisma) | `F:\RVIOS_APP\api` | `api.rvios.com` | أي مضيف Docker (Render · Railway · Fly · VPS) |
| AzmSmart (لوحة التاجر والمنصة) | `F:\مشروع نظام عزم سمارت\AzmSmart-OS` | `azm.rvios.com` | Vercel |
| RVIOS StoreOS (إنشاء المتاجر وواجهاتها) | `F:\rvios-next` | `store.rvios.com` · `rvios.store` · `*.rvios.store` | Vercel |
| الموقع الرئيسي | `F:\rvios-web` | `rvios.com` · `www.rvios.com` | Vercel |
| قاعدة البيانات | — | — | PostgreSQL مُدار (Neon · Supabase · RDS) |
| الصور | — | `cdn.rvios.com` (اختياري) | Cloudflare R2، حاوية `rvios-stores` |

> النطاقات أعلاه افتراضات تطابق القيم الافتراضية في الكود. إن اخترت غيرها فغيّر
> متغيّرات البيئة المقابلة فقط، لا الكود.

---

## ١. قاعدة البيانات

أنشئ قاعدة PostgreSQL (الإصدار ١٥ فأعلى) وخذ رابطها:

```
postgresql://USER:PASSWORD@HOST:5432/DB?schema=public&sslmode=require
```

لا حاجة لتشغيل شيء يدويًا: الصورة تطبّق الترحيلات (`prisma migrate deploy`) عند كل إقلاع.

> لا تستعمل قاعدة Supabase القديمة لمنصة المتاجر (`F:\RVIOS-StoreOS\…\.env`) — تلك بيانات تجّار
> حقيقيين بمخطط مختلف، ونقلها خطوة منفصلة.

## ٢. الباكند (`api.rvios.com`)

ابنِ من `F:\RVIOS_APP\api\Dockerfile` (المضيف يبنيه من المستودع عادةً):

```bash
docker build -t azm-api .
```

**المنفذ:** 3000 · **فحص الصحّة:** `GET /api/v1/health` (‏200 حين يصل إلى القاعدة).

### متغيّرات البيئة

الخادم **يرفض الإقلاع** في الإنتاج إن نقص مطلوب أو بقيت قيمة تطوير (`src/config/env.ts`)،
ويطبع السبب بالعربية في السجل.

| المتغيّر | مطلوب | القيمة |
|---|---|---|
| `NODE_ENV` | ✅ | `production` (مضبوط في الصورة) |
| `DATABASE_URL` | ✅ | رابط القاعدة من الخطوة ١ |
| `JWT_SECRET` | ✅ | سرّ جديد، ٣٢ حرفًا فأكثر: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_EXPIRES_IN` | | `7d` |
| `PUBLIC_API_URL` | ✅ | `https://api.rvios.com` |
| `CORS_ORIGINS` | ✅ | `https://azm.rvios.com,https://store.rvios.com,https://rvios.store,https://*.rvios.store,https://rvios.com,https://www.rvios.com` |
| `VISIT_SALT` | ✅ | نص عشوائي ثابت (لا تغيّره بعد الإطلاق وإلا تضاعفت أعداد الزوّار) |
| `CF_ACCOUNT_ID` · `CF_ACCESS_KEY_ID` · `CF_SECRET_ACCESS_KEY` · `CF_BUCKET_NAME` · `CF_PUBLIC_URL` | ✅ | مفاتيح R2 — انظر §٦ |
| `TRUST_PROXY` | | `1` افتراضيًا: عدد الوسطاء أمام الخادم (موازن المضيف). خلف Cloudflare + موازن: `2` |
| `NOTIFY_CHANNELS` | | `console` حتى يكتمل إعداد Meta، ثم `whatsapp,console` |
| `META_TOKEN` · `WA_PHONE_ID` · `META_APP_SECRET` · `WA_API_VERSION` | | واتساب — `docs/SETUP-META.md` |
| `BILLING_WORKER` · `WEBHOOK_WORKER` | | اتركهما. على أكثر من نسخة: `0` في كل النسخ عدا واحدة |

> واجهة المتجر العامة (`/api/v1/shop/storefront/*`) مفتوحة لكل الأصول عمدًا — النطاقات
> الخاصة للتجّار لا تُحصى، ومساراتها بلا جلسة. كل ما سواها محصور في `CORS_ORIGINS`.

> حدود الطلبات العامة (طلبات المتاجر، نموذج التواصل) في ذاكرة الخادم: على أكثر من
> نسخة يصير الحدّ لكل نسخة. نسخة واحدة تكفي في البداية.

## ٣. AzmSmart (`azm.rvios.com`)

مشروع Next.js على Vercel، الجذر `AzmSmart-OS`. الأوامر الافتراضية تكفي (`next build`).

| المتغيّر | القيمة |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.rvios.com/api/v1` |
| `NEXT_PUBLIC_STOREFRONT_URL` | `https://rvios.store` — روابط «زيارة المتجر» (`/s/<slug>`) |
| `NEXT_PUBLIC_STOREFRONT_CNAME` | `rvios.store` — ما يوجّه إليه التاجر DNS نطاقه الخاص (انظر §٥) |
| `NEXT_PUBLIC_RVIOS_URL` | `https://www.rvios.com` |
| `NEXT_PUBLIC_STOREOS_URL` | `https://store.rvios.com` |

البناء **يفشل عمدًا** إن غاب `NEXT_PUBLIC_API_URL` أو أشار إلى localhost — قيم
`NEXT_PUBLIC_*` تُخبز وقت البناء، فأعد البناء بعد أي تغيير فيها.

## ٤. RVIOS StoreOS (`store.rvios.com` · `rvios.store` · `*.rvios.store`)

مشروع Next.js على Vercel، الجذر `rvios-next`.

| المتغيّر | القيمة |
|---|---|
| `NEXT_PUBLIC_UNIFIED_API_URL` | `https://api.rvios.com/api/v1` |
| `NEXT_PUBLIC_AZMSMART_URL` | `https://azm.rvios.com` |
| `NEXT_PUBLIC_PLATFORM_HOSTS` | اتركه إن طابقت النطاقات الجدول أعلاه؛ وإلا: كل نطاقات المنصة نفسها مفصولة بفواصل |
| `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **اتركهما فارغين** — الوضع الموحّد يعلو عليهما |

البناء يفشل إن غاب الباكند (كان سيُنشر وضع العرض الذي يحفظ المتاجر في متصفح الزائر).

**النطاقات في Vercel:** أضف `store.rvios.com` و`rvios.store` و`www.rvios.store` و`*.rvios.store`.
النطاق الفرعي البرّي (`*.rvios.store`) يتطلّب أن تكون خوادم أسماء `rvios.store` عند Vercel
(لإصدار شهادة wildcard). `store.rvios.com` يكفيه CNAME إلى `cname.vercel-dns.com`.

## ٥. النطاقات الخاصة للتجّار

التاجر (باقة مدفوعة) يكتب نطاقه في AzmSmart ← إعدادات المتجر ← «النطاق الخاص»، ويوجّه:

```
CNAME  www  →  rvios.store        (NEXT_PUBLIC_STOREFRONT_CNAME)
ALIAS  @    →  rvios.store        (إن دعمه مسجّله)
```

`middleware.ts` في rvios-next يسأل الباكند عن المتجر صاحب النطاق ويعرضه. **ما يبقى عليك
لكل نطاق جديد:** إضافته إلى مشروع rvios-next في Vercel ليصدر له شهادة SSL — يدويًا من
اللوحة، أو آليًا لاحقًا عبر Vercel API عند حفظ التاجر لنطاقه.

> إن نُشرت المنصة على Vercel فوجهة CNAME الأصح هي `cname.vercel-dns.com` — اضبط
> `NEXT_PUBLIC_STOREFRONT_CNAME` عليها في AzmSmart.

## ٦. الصور: Cloudflare R2

- الحاوية `rvios-stores`؛ الصور في `stores/<storeId>/` و`companies/<companyId>/` (WebP).
- الرفع من الباكند مباشرة، فلا حاجة لإعداد CORS على الحاوية.
- **قبل الإطلاق:** رابط `*.r2.dev` محدود السرعة ولا يُنصح به للإنتاج. اربط نطاقًا
  (`cdn.rvios.com`) بالحاوية من لوحة R2 واجعله `CF_PUBLIC_URL`. افعل ذلك قبل أن يرفع
  التجّار صورًا: الروابط تُحفظ كاملة، وتنظيف الصور غير المستعملة لا يتعرّف إلا على
  روابط `CF_PUBLIC_URL` الحالي.
- **دوّر مفاتيح R2** المستعملة في التطوير وأنشئ مفاتيح إنتاج محصورة بالحاوية.

## ٧. الموقع الرئيسي (`rvios.com`)

مشروع Next.js على Vercel، الجذر `rvios-web`.

| المتغيّر | القيمة |
|---|---|
| `NEXT_PUBLIC_UNIFIED_API_URL` | `https://api.rvios.com/api/v1` — رسائل نموذج التواصل تُحفظ في AzmSmart |
| `NEXT_PUBLIC_STOREOS_URL` | `https://store.rvios.com` |
| `NEXT_PUBLIC_AZMSMART_URL` | `https://azm.rvios.com` |
| `RESEND_API_KEY` · `CONTACT_TO_EMAIL` | اختياري — نسخة بريدية من رسائل التواصل |

### رقم التواصل حسب دولة الزائر (الموقع الرئيسي ومنصة المتاجر)

زائر من السعودية يرى الرقم السعودي وعنوانها، وكل من سواه (ومن لم تُعرف دولته) يرى الرقم
اليمني واليمن. الأرقام والعناوين في ملف واحد لكل مشروع: `rvios-web/lib/content/contact.ts`
و`rvios-next/lib/contact.ts`.

- **الدولة** من ترويسة يضيفها المستضيف بعد GeoIP عنده: `x-vercel-ip-country` (Vercel — تلقائي)
  أو `cf-ipcountry` (Cloudflare — فعّل «IP Geolocation» في لوحة النطاق) أو
  `cloudfront-viewer-country`. أي وسيط آخر: يضبط `x-country-code`.
- **التخزين المؤقت آمن:** صفحة HTML واحدة لكل الزوّار فيها النسختان، والوسيط (proxy/middleware)
  يكتب المنطقة في كوكي `rv-region` يقرؤه سكربت قبل الرسم فيُخفي النسخة الأخرى. لا تُفعّل في
  أي CDN تخزين HTML حسب الكوكي ولا «Cache Everything» يتجاهل الوسيط — الوسيط يجب أن يعمل
  مع كل طلب صفحة (وهو كذلك على Vercel).
- **تثبيت يدوي** لمن يخطئ تحديد دولته (VPN، شبكات الجوال): `?region=sa` أو `?region=ye` في أي رابط.

## ٨. التشغيل الأول (مرّة واحدة)

بعد أن يعمل الباكند ويُظهر `/api/v1/health` القيمة `"ok": true`:

1. **حسابك:** سجّل من `https://azm.rvios.com/register`.
2. **صلاحية فريق المنصة** — من طرفية الحاوية (Render/Railway: Shell):
   ```bash
   npm run platform:grant:prod -- you@rvios.com 2
   ```
   (`2` = مدير عام · `1` = فوترة · `0` = دعم). أعد تحميل AzmSmart فيظهر قسم «المنصة».
3. **منظمة الموقع الرئيسي** (لرسائل التواصل ومحتوى الموقع):
   ```bash
   npm run cms:seed-site:prod -- you@rvios.com
   ```
4. **الأسعار والدفع** — AzmSmart ← المنصة ← الإعدادات: العملة، سعر الاحترافية
   والأعمال الشهري، الأشهر المجانية في السنوي، أسعار القوالب، وأرقام حسابات الدفع
   (الكريمي · جيب · PayPal) التي تظهر للتاجر عند الدفع.

## ٩. فحص ما بعد النشر

- [ ] `https://api.rvios.com/api/v1/health` ← `{"ok":true,"db":"up"}`
- [ ] `https://store.rvios.com` ← أنشئ متجرًا مجانيًا (حساب جديد) ← يفتح على `https://<slug>.rvios.store`
- [ ] اطلب من المتجر ← يظهر الطلب في AzmSmart ← الطلبات
- [ ] ارفع صورة منتج ← رابطها على `CF_PUBLIC_URL`
- [ ] متجر مدفوع: إيصال ← الفاتورة في المنصة ← الفواتير
- [ ] `https://rvios.com` ← نموذج التواصل ← الرسالة في AzmSmart ← الموقع ← الرسائل
- [ ] نطاق تجريبي خاص ← يفتح المتجر بعد إضافته في Vercel

## ١٠. قبل الإطلاق — أمان

- مفاتيح استُعملت أثناء التطوير تُدوَّر كلها: R2، Supabase القديم، رمز Meta إن كان في ملف محلي.
- `JWT_SECRET` جديد للإنتاج (تغييره لاحقًا يُخرج كل المستخدمين).
- لا `.env` في أي مستودع — `.env.example` وحده.
- نسخ احتياطي يومي للقاعدة من لوحة المزوّد.
