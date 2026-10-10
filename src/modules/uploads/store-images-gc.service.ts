import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { TenantPrismaService } from '../../common/prisma/tenant-prisma.service';
import { UploadsService } from './uploads.service';

/** لا يُحذف ملف أحدث من هذا: صورة رُفعت لتوّها ولم تُحفظ في منتج بعد ليست يتيمة */
const GRACE_MS = 60 * 60_000;
/** تجميع الطلبات المتتالية لمتجر واحد (تعديل منتجات متتابع) في كنسة واحدة */
const DEBOUNCE_MS = 30_000;
/** كنسة كل المتاجر مرة يوميًا — لما فات الكنس الفوري (رفع ثم تعديل خلال ساعة) */
const DAILY_MS = 24 * 60 * 60_000;

/**
 * منظّف صور المتاجر في R2 — يحذف من مجلد المتجر (`stores/<id>/`) ما لم يعد
 * يشير إليه شيء: صورة منتج حُذف، أو غلاف استُبدل، أو معرض أُعيد ترتيبه.
 *
 * «يشير إليه» تشمل الإيصالات دائمًا — إيصال طلب (`payProof`) وإيصال فاتورة
 * منصة (`proofKey`) سجلّ مالي لا صورة عرض، فلا تُحذف ولو حُذف المتجر.
 *
 * يعمل على R2 وحده (القرص المحلي للتطوير لا يُكنس)، وفي الاختبارات لا يعمل.
 * `STORAGE_GC=0` يوقف الكنس كله.
 */
@Injectable()
export class StoreImagesGc implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('StoreImagesGc');
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private daily?: NodeJS.Timeout;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly uploads: UploadsService,
  ) {}

  private get enabled() {
    return !!this.uploads.cloud && process.env.STORAGE_GC !== '0' && process.env.NODE_ENV !== 'test';
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.daily = setInterval(() => void this.sweepAll(), DAILY_MS);
    this.daily.unref();
  }

  onModuleDestroy() {
    if (this.daily) clearInterval(this.daily);
    for (const t of this.pending.values()) clearTimeout(t);
  }

  /** يجدول كنسة لمتجر بعد تعديل — لا يُبطئ الطلب ولا يُفشله. */
  schedule(storeId: string) {
    if (!this.enabled) return;
    clearTimeout(this.pending.get(storeId));
    const t = setTimeout(() => {
      this.pending.delete(storeId);
      void this.sweep(storeId).catch((e) => this.log.warn(`كنس ${storeId}: ${(e as Error).message}`));
    }, DEBOUNCE_MS);
    t.unref();
    this.pending.set(storeId, t);
  }

  /** بعد حذف متجر: كل صوره إلا الإيصالات، بلا مهلة — لا منتج سيُحفظ فيه بعد الآن. */
  purge(storeId: string) {
    if (!this.enabled) return;
    void this.sweep(storeId, { grace: 0 }).catch((e) => this.log.warn(`حذف صور ${storeId}: ${(e as Error).message}`));
  }

  /** الروابط التي ما زال المتجر يستعملها — صوره وإيصالاته */
  private async referenced(storeId: string): Promise<Set<string>> {
    const [store, products, gallery, variants, orders, invoices] = await Promise.all([
      this.prisma.shopStore.findUnique({ where: { id: storeId }, select: { logo: true, banner: true, showcase: true } }),
      this.prisma.shopProduct.findMany({ where: { storeId }, select: { image: true } }),
      this.prisma.shopProductImage.findMany({ where: { storeId }, select: { url: true } }),
      this.prisma.shopProductVariant.findMany({ where: { storeId }, select: { image: true } }),
      this.prisma.shopOrder.findMany({ where: { storeId, payProof: { not: '' } }, select: { payProof: true } }),
      this.prisma.platformInvoice.findMany({ where: { storeRef: storeId, proofKey: { not: null } }, select: { proofKey: true } }),
    ]);
    const urls = [
      store?.logo, store?.banner, store?.showcase,
      ...products.map((p) => p.image), ...gallery.map((g) => g.url), ...variants.map((v) => v.image),
      ...orders.map((o) => o.payProof), ...invoices.map((i) => i.proofKey),
    ];
    const r2 = this.uploads.cloud!;
    return new Set(urls.filter((u): u is string => !!u).map((u) => r2.keyOf(u)).filter((k): k is string => !!k));
  }

  async sweep(storeId: string, { grace = GRACE_MS }: { grace?: number } = {}): Promise<number> {
    const r2 = this.uploads.cloud;
    if (!r2) return 0;
    const keep = await this.referenced(storeId);
    const cutoff = Date.now() - grace;
    const objects = await r2.list(`stores/${storeId}/`);
    const orphans = objects.filter((o) => !keep.has(o.key) && o.modified.getTime() <= cutoff).map((o) => o.key);
    if (orphans.length) {
      await r2.remove(orphans);
      this.log.log(`متجر ${storeId}: حُذفت ${orphans.length} صورة لم تعد مستعملة`);
    }
    return orphans.length;
  }

  private async sweepAll() {
    const stores = await this.prisma.shopStore.findMany({ select: { id: true } });
    for (const s of stores) await this.sweep(s.id).catch((e) => this.log.warn(`كنس ${s.id}: ${(e as Error).message}`));
  }
}
