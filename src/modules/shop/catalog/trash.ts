import { ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../../common/prisma/tenant-prisma.service';
import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { StoreImagesGc } from '../../uploads/store-images-gc.service';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { ProductSnapshot } from './trash-snapshot';

/** مدة البقاء في سلة المحذوفات قبل الحذف النهائي */
export const TRASH_DAYS = 30;

type Tx = Prisma.TransactionClient;

/**
 * يحذف المنتج إلى السلة داخل معاملة: لقطة كاملة ثم الحذف (الذي يُسقط معه المعرض والخيارات
 * والتقييمات والأسئلة). أسطر الطلبات تحتفظ بمعرّف المنتج نصًّا، فتعود مرتبطة بعد الاستعادة.
 */
export async function trashProduct(tx: Tx, companyId: string, storeId: string, id: string): Promise<boolean> {
  const p = await tx.shopProduct.findFirst({ where: { id, storeId }, include: { images: true, variants: true, reviews: true, questions: true } });
  if (!p) return false;
  const { images, variants, reviews, questions, ...product } = p;
  const data: ProductSnapshot = { product, images, variants, reviews, questions };
  await tx.shopTrash.create({
    data: {
      companyId,
      storeId,
      kind: 'product',
      refId: p.id,
      name: p.name,
      image: p.image,
      data: data as unknown as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + TRASH_DAYS * 86_400_000),
    },
  });
  await tx.shopProduct.delete({ where: { id: p.id } });
  return true;
}

@Injectable()
export class ShopTrashService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly gc: StoreImagesGc,
  ) {}

  async list(ctx: TenantContext, storeId: string) {
    await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    // المنتهي يُحذف نهائيًا عند أول قراءة بعد مدته
    const expired = await db.shopTrash.deleteMany({ where: { storeId, expiresAt: { lt: new Date() } } });
    if (expired.count) this.gc.schedule(storeId);
    return db.shopTrash.findMany({
      where: { storeId },
      orderBy: { deletedAt: 'desc' },
      select: { id: true, kind: true, refId: true, name: true, image: true, deletedAt: true, expiresAt: true },
    });
  }

  async restore(ctx: TenantContext, storeId: string, id: string) {
    const { limits } = await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const t = await db.shopTrash.findFirst({ where: { id, storeId } });
    if (!t) throw new NotFoundException('غير موجود في السلة');
    if (limits.products !== null && (await db.shopProduct.count({ where: { storeId } })) >= limits.products) {
      throw new ConflictException('بلغتَ حدّ منتجات باقتك — احذف منتجًا أو رقِّ باقتك ثم استعد');
    }
    const d = t.data as unknown as ProductSnapshot;
    await this.prisma.$transaction(async (tx) => {
      if (await tx.shopProduct.findUnique({ where: { id: t.refId }, select: { id: true } })) {
        throw new ConflictException('المنتج موجود بالفعل');
      }
      // التصنيف قد يكون حُذف بعده — يعود بلا تصنيف بدل أن تفشل الاستعادة
      const product = { ...d.product } as Prisma.ShopProductUncheckedCreateInput;
      if (product.categoryId && !(await tx.shopCategory.findFirst({ where: { id: product.categoryId as string, storeId }, select: { id: true } }))) {
        product.categoryId = null;
      }
      await tx.shopProduct.create({ data: product });
      if (d.images.length) await tx.shopProductImage.createMany({ data: d.images as Prisma.ShopProductImageCreateManyInput[] });
      if (d.variants.length) await tx.shopProductVariant.createMany({ data: d.variants as Prisma.ShopProductVariantCreateManyInput[] });
      if (d.reviews.length) await tx.shopReview.createMany({ data: d.reviews as Prisma.ShopReviewCreateManyInput[], skipDuplicates: true });
      if (d.questions.length) await tx.shopQuestion.createMany({ data: d.questions as Prisma.ShopQuestionCreateManyInput[] });
      await tx.shopTrash.delete({ where: { id: t.id } });
    });
    return { ok: true, productId: t.refId };
  }

  async purge(ctx: TenantContext, storeId: string, id?: string) {
    await this.access.require(ctx, storeId, { writable: true });
    const db = this.prisma.forTenant(ctx.companyId);
    const r = await db.shopTrash.deleteMany({ where: { storeId, ...(id ? { id } : {}) } });
    if (id && !r.count) throw new NotFoundException('غير موجود في السلة');
    this.gc.schedule(storeId);
    return { ok: true, deleted: r.count };
  }
}

@Controller('shop/stores/:storeId/trash')
export class ShopTrashController {
  constructor(private readonly trash: ShopTrashService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.trash.list(ctx, storeId);
  }

  @RequireRole(UserRole.Employee)
  @Post(':id/restore')
  restore(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.trash.restore(ctx, storeId, id);
  }

  /** حذف نهائي لعنصر — للمدير فأعلى: لا رجعة فيه */
  @RequireRole(UserRole.DeptManager)
  @Delete(':id')
  purgeOne(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.trash.purge(ctx, storeId, id);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete()
  empty(@Tenant() ctx: TenantContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.trash.purge(ctx, storeId);
  }
}
