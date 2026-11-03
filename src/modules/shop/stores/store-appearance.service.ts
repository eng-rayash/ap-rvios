import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { PlatformContext, TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { CatalogService } from '../catalog/catalog.service';
import { StorefrontCache } from '../public/storefront-cache.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { SaveAppearanceDto } from './stores.dto';
import { StoresService, storeView } from './stores.service';

/**
 * نصوص القالب تُعرَّف في منصة المتاجر لكل قالب، فالخادم لا يعرف مفاتيحها: يقبل أي مفتاح بصيغة
 * المعرّفات ويقصّ القيم — النص يُعرض نصًّا لا HTML، فلا يحقن شيئًا.
 */
const COPY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const COPY_MAX = 600;
/** عنصر محذوف: مفتاح نص، أو صورة قالب `img:<معرّفها>`، أو الشعار */
const HIDDEN_KEY = /^(img:)?[\w./:@-]{1,160}$/;
/** صورة قالب ← صورة التاجر: رابط https أو مسار محلي فقط */
const IMAGE_URL = /^(https:\/\/|\/)[^\s"'<>]{1,600}$/;
const MAX_ENTRIES = 80;
/** معرّف خط من قائمة منصة المتاجر — الخط نفسه يُحمَّل هناك، فمعرّف مجهول يعود لخط القالب */
const FONT_ID = /^[a-z]{2,20}$/;
const NETWORKS = new Set(['instagram', 'facebook', 'tiktok', 'snapchat', 'x', 'youtube', 'telegram', 'whatsapp']);
const PLACEMENTS = new Set(['info', 'footer', 'both']);
/** اسم مستخدم أو رابط https — بلا مسافات ولا علامات تكسر الرابط */
const SOCIAL_VALUE = /^(https:\/\/[^\s"'<>]{4,300}|@?[\w.\-+]{1,80})$/;
/** بعد كل حفظ من التاجر يُقفل التعديل أسبوعًا، إلا أن يفتحه فريق RVIOS */
const LOCK_MS = 7 * 24 * 60 * 60_000;

/**
 * «شكل المتجر» لكل القوالب: النصوص والصور والشعار والاسم واللون والمنتجات، دفعة واحدة. الحذف قبل
 * الإضافة (حدّ منتجات الباقة)، والقفل آخرًا كي لا يُقفل تعديل فشل. فريق المنصة يعدّل بلا قفل.
 */
@Injectable()
export class StoreAppearanceService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly stores: StoresService,
    private readonly catalog: CatalogService,
    private readonly cache: StorefrontCache,
  ) {}

  async save(ctx: TenantContext, storeId: string, dto: SaveAppearanceDto, { asTeam = false } = {}) {
    const { store, plan } = await this.access.require(ctx, storeId, { writable: true });
    if (!asTeam && store.appearanceLockedUntil && store.appearanceLockedUntil > new Date()) {
      throw new ConflictException({
        message: 'عُدّل شكل المتجر مؤخرًا — يُتاح التعديل بعد انتهاء الأسبوع أو بالتواصل مع فريق RVIOS',
        code: 'APPEARANCE_LOCKED',
      });
    }

    const copy = Object.fromEntries(
      Object.entries(dto.copy ?? {})
        .filter(([k, v]) => COPY_KEY.test(k) && typeof v === 'string' && v.trim())
        .slice(0, MAX_ENTRIES)
        .map(([k, v]) => [k, v.trim().slice(0, COPY_MAX)]),
    );
    const images = Object.fromEntries(
      Object.entries(dto.images ?? {})
        .filter(([k, v]) => HIDDEN_KEY.test(k) && typeof v === 'string' && IMAGE_URL.test(v.trim()))
        .slice(0, MAX_ENTRIES)
        .map(([k, v]) => [k, v.trim()]),
    );
    const hidden = [...new Set(dto.hidden ?? [])].filter((k) => HIDDEN_KEY.test(k)).slice(0, MAX_ENTRIES);
    const fonts = Object.fromEntries(
      (['display', 'body'] as const).flatMap((k) => (typeof dto.fonts?.[k] === 'string' && FONT_ID.test(dto.fonts[k]) ? [[k, dto.fonts[k]]] : [])),
    );
    const social: Record<string, string> = Object.fromEntries(
      Object.entries(dto.social ?? {})
        .filter(([k, v]) => NETWORKS.has(k) && typeof v === 'string' && SOCIAL_VALUE.test(v.trim()))
        .map(([k, v]) => [k, v.trim().replace(/^@/, '')]),
    );
    if (typeof dto.social?.placement === 'string' && PLACEMENTS.has(dto.social.placement)) social.placement = dto.social.placement;

    for (const id of dto.deleteProducts ?? []) {
      await this.catalog.removeProduct(ctx, storeId, id).catch((e: unknown) => {
        // حُذف من صفحة المنتجات أثناء التعديل: المطلوب حاصل
        if (!(e instanceof NotFoundException)) throw e;
      });
    }
    for (const p of dto.products ?? []) {
      // صورة لم تتغيّر لا تُرسل: استبدال المعرض بصورة واحدة يُسقط بقية صور المنتج
      const fields = { name: p.name, price: p.price, oldPrice: p.oldPrice ?? 0, ...(p.image !== undefined ? { images: p.image ? [p.image] : [] } : {}) };
      if (p.id) await this.catalog.updateProduct(ctx, storeId, p.id, fields);
      else await this.catalog.createProduct(ctx, storeId, { ...fields, qty: 20, live: true });
    }

    await this.stores.update(ctx, storeId, {
      name: dto.name, logo: dto.logo, banner: dto.banner, showcase: dto.showcase,
      ...(dto.color ? { color: dto.color, colorDeep: dto.color } : {}),
    });

    const saved = await this.prisma.forTenant(ctx.companyId).shopStore.update({
      where: { id: storeId },
      data: {
        appearance: { copy, hidden, images, fonts, social },
        ...(asTeam ? {} : { appearanceLockedUntil: new Date(Date.now() + LOCK_MS) }),
      },
    });
    this.cache.purge(saved.slug);
    return { store: storeView(saved, plan) };
  }

  /** فريق المنصة يعمل داخل شركة المتجر بصلاحية مالكها — لهذا المتجر وحده */
  private async asOwner(storeId: string, staff: PlatformContext): Promise<TenantContext> {
    const store = await this.prisma.shopStore.findUnique({ where: { id: storeId }, select: { companyId: true } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    return { userId: staff.userId, companyId: store.companyId, role: UserRole.Owner, membershipId: `platform:${staff.userId}` };
  }

  /** ما يحتاجه محرر الشكل في لوحة المنصة: المتجر ومنتجاته */
  async teamEditor(storeId: string, staff: PlatformContext) {
    const ctx = await this.asOwner(storeId, staff);
    const [{ store }, products] = await Promise.all([this.stores.get(ctx, storeId), this.catalog.listProducts(ctx, storeId)]);
    return { store, ...products };
  }

  async teamSave(storeId: string, staff: PlatformContext, dto: SaveAppearanceDto) {
    return this.save(await this.asOwner(storeId, staff), storeId, dto, { asTeam: true });
  }

  /** فريق RVIOS يفتح التعديل قبل انتهاء الأسبوع */
  async unlock(storeId: string) {
    const store = await this.prisma.shopStore.findUnique({ where: { id: storeId }, select: { id: true } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    return this.prisma.shopStore.update({
      where: { id: storeId },
      data: { appearanceLockedUntil: null },
      select: { id: true, appearanceLockedUntil: true },
    });
  }
}
