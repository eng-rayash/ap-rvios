import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShopProduct, ShopProductVariant } from '@prisma/client';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { StoreImagesGc } from '../../uploads/store-images-gc.service';
import { ShopStoreAccessService, StoreAccess } from '../shop-store-access.service';
import { PLAN_NAME } from '../shop.constants';
import {
  CreateCategoryDto,
  ProductDto,
  UpdateCategoryDto,
  VariantDto,
} from './catalog.dto';

type Tx = Prisma.TransactionClient;

/** التسمية المعروضة لخيار: «أسود · مقاس M» */
export function variantLabel(
  p: Pick<ShopProduct, 'opt1Name' | 'opt2Name'>,
  v: Pick<ShopProductVariant, 'v1' | 'v2'>,
): string {
  const parts: string[] = [];
  if (v.v1) parts.push(p.opt1Name ? `${p.opt1Name}: ${v.v1}` : v.v1);
  if (v.v2) parts.push(p.opt2Name ? `${p.opt2Name}: ${v.v2}` : v.v2);
  return parts.join(' · ');
}

/** السعر الفعّال لخيار — null يعني «يرث سعر المنتج». */
export const variantPrice = (
  p: Pick<ShopProduct, 'price'>,
  v: Pick<ShopProductVariant, 'price'>,
): number => (v.price ?? p.price);

/**
 * يعيد حساب مخزون المنتج من مجموع كميات خياراته المعروضة.
 *
 * الثابت الحاكم: hasVariants=false ← `qty` مصدر الحقيقة. hasVariants=true ←
 * مصدر الحقيقة مجموع الخيارات و`qty` نسخة مخزَّنة منه. كل تغيير في كمية
 * خيار يمرّ بهذه الدالة داخل المعاملة نفسها، فلا تنحرف النسخة أبدًا.
 */
export async function recalcStock(tx: Tx, productId: string): Promise<number> {
  const rows = await tx.shopProductVariant.findMany({ where: { productId } });
  const total = rows.reduce((a, v) => a + (v.live ? Math.max(0, v.qty) : 0), 0);
  await tx.shopProduct.update({ where: { id: productId }, data: { qty: total } });
  return total;
}

const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly gc: StoreImagesGc,
  ) {}

  // ═══ التصنيفات ═══════════════════════════════════════════

  async listCategories(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const cats = await db.shopCategory.findMany({
      where: { storeId },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
    const counts = await db.shopProduct.groupBy({
      by: ['categoryId'],
      where: { storeId },
      _count: { _all: true },
    });
    const byCat = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    return cats.map((c) => ({ ...c, count: byCat.get(c.id) ?? 0 }));
  }

  async createCategory(ctx: TenantContext, storeId: string, dto: CreateCategoryDto) {
    const { limits } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);

    let parentId: string | null = null;
    if (dto.parentId) {
      // التصنيفات الفرعية ميزة مدفوعة (§٢.١)
      if (!limits.subcategories) {
        throw new ConflictException({
          message: `التصنيفات الفرعية متاحة في باقتي ${PLAN_NAME.plus} و${PLAN_NAME.pro}`,
          code: 'PLAN_LIMIT',
        });
      }
      const parent = await db.shopCategory.findFirst({
        where: { id: dto.parentId, storeId },
      });
      if (!parent) throw new BadRequestException('التصنيف الأب غير موجود');
      parentId = parent.id;
    }

    const sort = dto.sort ?? (await db.shopCategory.count({ where: { storeId } })) + 1;
    return db.shopCategory.create({
      data: tenantCreate<Prisma.ShopCategoryUncheckedCreateInput>({
        storeId,
        name: dto.name.trim(),
        parentId,
        sort,
      }),
    });
  }

  private async category(ctx: TenantContext, storeId: string, id: string) {
    const db = this.prisma.forTenant(ctx.companyId);
    const cat = await db.shopCategory.findFirst({ where: { id, storeId } });
    if (!cat) throw new NotFoundException('التصنيف غير موجود');
    return cat;
  }

  async updateCategory(
    ctx: TenantContext,
    storeId: string,
    id: string,
    dto: UpdateCategoryDto,
  ) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.category(ctx, storeId, id);
    const db = this.prisma.forTenant(ctx.companyId);
    return db.shopCategory.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
      },
    });
  }

  async removeCategory(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    await this.category(ctx, storeId, id);
    const db = this.prisma.forTenant(ctx.companyId);
    // المنتجات والفروع تتحرّر (SetNull) ولا تُحذف
    await db.shopCategory.delete({ where: { id } });
    return { ok: true };
  }

  // ═══ المنتجات ════════════════════════════════════════════

  private capacity(access: StoreAccess, used: number) {
    const max = access.limits.products;
    return {
      used,
      max,
      canAdd: max === null || used < max,
      imagesPerProduct: access.limits.imagesPerProduct,
      variantsPerProduct: access.limits.variantsPerProduct,
    };
  }

  private shape(
    p: ShopProduct & {
      images: { id: string; url: string; sort: number }[];
      variants: ShopProductVariant[];
      category?: { name: string } | null;
    },
  ) {
    return {
      ...p,
      categoryName: p.category?.name ?? '',
      category: undefined,
      images: [...p.images].sort((a, b) => a.sort - b.sort).map((i) => i.url),
      variants: [...p.variants].sort((a, b) => a.sort - b.sort),
    };
  }

  private static readonly INCLUDE = {
    images: { orderBy: { sort: 'asc' as const } },
    variants: { orderBy: { sort: 'asc' as const } },
    category: { select: { name: true } },
  };

  async listProducts(ctx: TenantContext, storeId: string) {
    const access = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const products = await db.shopProduct.findMany({
      where: { storeId },
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
      include: CatalogService.INCLUDE,
    });
    return {
      products: products.map((p) => this.shape(p)),
      capacity: this.capacity(access, products.length),
    };
  }

  async getProduct(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    const p = await db.shopProduct.findFirst({
      where: { id, storeId },
      include: CatalogService.INCLUDE,
    });
    if (!p) throw new NotFoundException('المنتج غير موجود');
    return this.shape(p);
  }

  /** حقول المنتج العادية من الـDTO — بعد تنظيفها. */
  private async fields(
    ctx: TenantContext,
    storeId: string,
    dto: ProductDto,
  ): Promise<Prisma.ShopProductUncheckedUpdateInput> {
    const f: Prisma.ShopProductUncheckedUpdateInput = {};
    if (dto.name !== undefined) f.name = clip(dto.name, 100);
    if (dto.summary !== undefined) f.summary = clip(dto.summary, 120);
    if (dto.description !== undefined) f.description = clip(dto.description, 1200);
    if (dto.variant !== undefined) f.variant = clip(dto.variant, 40);
    if (dto.brand !== undefined) f.brand = clip(dto.brand, 60);
    if (dto.opt1Name !== undefined) f.opt1Name = clip(dto.opt1Name, 24);
    if (dto.opt2Name !== undefined) f.opt2Name = clip(dto.opt2Name, 24);
    if (dto.price !== undefined) f.price = dto.price;
    if (dto.qty !== undefined) f.qty = dto.qty;
    if (dto.lowStock !== undefined) f.lowStock = dto.lowStock;
    if (dto.live !== undefined) f.live = dto.live;
    if (dto.sort !== undefined) f.sort = dto.sort;
    if (dto.image !== undefined) f.image = dto.image.trim();
    if (dto.oldPrice !== undefined) f.oldPrice = dto.oldPrice > 0 ? dto.oldPrice : null;

    if (dto.categoryId !== undefined) {
      if (dto.categoryId === null) {
        f.categoryId = null;
      } else {
        // التصنيف من المتجر نفسه فقط — وإلا صار المنتج تحت تصنيف غيره
        const db = this.prisma.forTenant(ctx.companyId);
        const cat = await db.shopCategory.findFirst({
          where: { id: dto.categoryId, storeId },
          select: { id: true },
        });
        f.categoryId = cat ? cat.id : null;
      }
    }
    return f;
  }

  async createProduct(ctx: TenantContext, storeId: string, dto: ProductDto) {
    const access = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);

    // حدّ الباقة يُفرض في الخادم لا في الواجهة (§٢.٢)
    const count = await db.shopProduct.count({ where: { storeId } });
    const max = access.limits.products;
    if (max !== null && count >= max) {
      throw new ConflictException({
        message: `بلغتَ حد باقتك (${max} منتجًا). رقّ باقتك لإضافة المزيد.`,
        code: 'PLAN_LIMIT',
      });
    }
    if (!dto.name?.trim()) throw new BadRequestException('اسم المنتج مطلوب');

    const base = await this.fields(ctx, storeId, dto);
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shopProduct.create({
        data: {
          ...(base as Prisma.ShopProductUncheckedCreateInput),
          companyId: ctx.companyId,
          storeId,
          name: clip(dto.name, 100),
          price: dto.price ?? 0,
        },
      });
      await this.applyGallery(tx, ctx.companyId, storeId, created.id, dto, access);
      await this.applyVariants(tx, ctx.companyId, storeId, created.id, dto, access);
      return created.id;
    });
    return this.getProduct(ctx, storeId, id);
  }

  async updateProduct(
    ctx: TenantContext,
    storeId: string,
    id: string,
    dto: ProductDto,
  ) {
    const access = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const existing = await db.shopProduct.findFirst({ where: { id, storeId } });
    if (!existing) throw new NotFoundException('المنتج غير موجود');

    const base = await this.fields(ctx, storeId, dto);
    // حين توجد خيارات فالكمية تُدار منها؛ qty القادم من النموذج يُتجاهل —
    // وإلا لدَاس المجموعَ المحسوب رقمٌ قديم في نموذج التاجر
    if (existing.hasVariants && dto.variants === undefined) delete base.qty;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(base).length) {
        await tx.shopProduct.update({ where: { id }, data: base });
      }
      await this.applyGallery(tx, ctx.companyId, storeId, id, dto, access);
      await this.applyVariants(tx, ctx.companyId, storeId, id, dto, access);
    });
    // صورة استُبدلت أو أُزيلت من المعرض تُحذف من التخزين لاحقًا (بعد مهلتها)
    this.gc.schedule(storeId);
    return this.getProduct(ctx, storeId, id);
  }

  async removeProduct(ctx: TenantContext, storeId: string, id: string) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const p = await db.shopProduct.findFirst({ where: { id, storeId }, select: { id: true } });
    if (!p) throw new NotFoundException('المنتج غير موجود');
    await db.shopProduct.delete({ where: { id } });
    this.gc.schedule(storeId);
    return { ok: true };
  }

  // ── المعرض: استبدال ضمن حدّ الباقة، والأول غلاف ─────────
  private async applyGallery(
    tx: Tx,
    companyId: string,
    storeId: string,
    productId: string,
    dto: ProductDto,
    access: StoreAccess,
  ) {
    if (dto.images === undefined) return;
    const urls = dto.images
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, access.limits.imagesPerProduct);

    await tx.shopProductImage.deleteMany({ where: { productId } });
    if (urls.length) {
      await tx.shopProductImage.createMany({
        data: urls.map((url, sort) => ({ companyId, storeId, productId, url, sort })),
      });
    }
    await tx.shopProduct.update({
      where: { id: productId },
      data: { image: urls[0] ?? '' },
    });
  }

  // ── الخيارات: استبدال لا دمج ─────────────────────────────
  //  واجهة التاجر ترسل الشبكة كاملة في كل حفظ، والدمج التدريجي يترك
  //  صفوفًا يتيمة يستحيل حذفها. الصفوف المطابقة تُحدَّث بمعرّفها فلا
  //  تُفقد إحالات order_items.
  private async applyVariants(
    tx: Tx,
    companyId: string,
    storeId: string,
    productId: string,
    dto: ProductDto,
    access: StoreAccess,
  ) {
    if (dto.variants === undefined) return;
    const max = access.limits.variantsPerProduct ?? Number.POSITIVE_INFINITY;

    const seen = new Set<string>();
    const rows: Array<Required<Pick<VariantDto, 'v1' | 'v2' | 'qty' | 'sku' | 'live'>> & {
      id: string | null;
      price: number | null;
      image: string;
      sort: number;
    }> = [];
    for (const raw of dto.variants) {
      const v1 = clip(raw.v1, 40);
      const v2 = clip(raw.v2, 40);
      if (!v1 && !v2) continue; // صفّ فارغ
      const key = `${v1}\u0000${v2}`;
      if (seen.has(key)) continue; // المكرّر يُسقط بدل رفض الحفظ كله
      seen.add(key);
      rows.push({
        id: raw.id ?? null,
        v1,
        v2,
        price: raw.price === null || raw.price === undefined ? null : Math.max(0, raw.price),
        qty: Math.max(0, raw.qty ?? 0),
        sku: clip(raw.sku, 40),
        // صورة الخيار (لون مثلًا) — قالب «أتولييه» يعرضها في الشبكة وعند التمرير
        image: clip(raw.image, 600),
        live: raw.live !== false,
        sort: rows.length,
      });
      if (rows.length >= max) break; // حدّ الباقة — قصّ صامت
    }

    const existing = await tx.shopProductVariant.findMany({ where: { productId } });
    const keep = new Set<string>();

    for (const row of rows) {
      const match =
        existing.find((e) => row.id && e.id === row.id) ??
        existing.find((e) => e.v1 === row.v1 && e.v2 === row.v2 && !keep.has(e.id));
      const fields = {
        v1: row.v1, v2: row.v2, price: row.price, image: row.image,
        qty: row.qty, sku: row.sku, live: row.live, sort: row.sort,
      };
      if (match) {
        keep.add(match.id);
        await tx.shopProductVariant.update({ where: { id: match.id }, data: fields });
      } else {
        const created = await tx.shopProductVariant.create({
          data: { companyId, storeId, productId, ...fields },
        });
        keep.add(created.id);
      }
    }
    for (const e of existing) {
      if (!keep.has(e.id)) await tx.shopProductVariant.delete({ where: { id: e.id } });
    }

    const hasVariants = rows.length > 0;
    await tx.shopProduct.update({ where: { id: productId }, data: { hasVariants } });
    // حين تُلغى الخيارات كلها يعود products.qty مصدر الحقيقة ونتركه كما هو
    if (hasVariants) await recalcStock(tx, productId);
  }
}
