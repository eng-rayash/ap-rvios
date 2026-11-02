import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { CatalogService } from '../catalog/catalog.service';
import { StorefrontCache } from '../public/storefront-cache.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { SaveAppearanceDto } from './stores.dto';
import { StoresService, storeView } from './stores.service';

/** نصوص القالب الأساسي التي يعدّلها التاجر، وأطول طول لكلٍّ */
const COPY_MAX: Record<string, number> = { h1: 120, sub: 240, shop: 40, prods: 60, story: 80, storyTxt: 600, city: 80 };
/** عناصر الواجهة التي يمكن حذفها — اسم المتجر والمنتجات لها مسارها */
const HIDEABLE = new Set(['logo', 'heroImg', 'h1', 'sub', 'shop', 'prods', 'story', 'storyTxt', 'storyImg', 'city']);
/** بعد كل حفظ يُقفل التعديل أسبوعًا، إلا أن يفتحه فريق RVIOS */
const LOCK_MS = 7 * 24 * 60 * 60_000;

/**
 * «شكل المتجر»: محرر الواجهة للمتجر المجاني على القالب الأساسي. الحفظ دفعة واحدة:
 * الحذف قبل الإضافة (حدّ منتجات الباقة)، والقفل آخرًا كي لا يُقفل تعديل فشل.
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

  async save(ctx: TenantContext, storeId: string, dto: SaveAppearanceDto) {
    const { store, plan } = await this.access.require(ctx, storeId, { writable: true });
    if (plan !== 'basic' || storeView(store, plan).template !== 'essential') {
      throw new ConflictException({
        message: 'شكل المتجر متاح للمتجر المجاني على القالب الأساسي — تواصل مع فريق RVIOS لتعديل قالبك',
        code: 'APPEARANCE_UNAVAILABLE',
      });
    }
    if (store.appearanceLockedUntil && store.appearanceLockedUntil > new Date()) {
      throw new ConflictException({
        message: 'عُدّل شكل المتجر مؤخرًا — يُتاح التعديل بعد انتهاء الأسبوع أو بالتواصل مع فريق RVIOS',
        code: 'APPEARANCE_LOCKED',
      });
    }

    const copy: Record<string, string> = {};
    for (const [k, max] of Object.entries(COPY_MAX)) {
      const v = dto.copy?.[k];
      if (typeof v === 'string' && v.trim()) copy[k] = v.trim().slice(0, max);
    }
    const hidden = [...new Set(dto.hidden ?? [])].filter((k) => HIDEABLE.has(k));

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

    const until = new Date(Date.now() + LOCK_MS);
    const saved = await this.prisma.forTenant(ctx.companyId).shopStore.update({
      where: { id: storeId },
      data: { appearance: { copy, hidden }, appearanceLockedUntil: until },
    });
    this.cache.purge(saved.slug);
    return { store: storeView(saved, plan) };
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
