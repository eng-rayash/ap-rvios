/* لقطة المنتج في سلة المحذوفات — ملف بلا اعتماديات: يستورده منظّف الصور ووحدة السلة معًا
   (استيراد trash.ts من المنظّف كان يُحدث دورة استيراد تجعل StoreImagesGc غير معرّف عند الإقلاع). */

/** لقطة المنتج كاملة: صفّه ومعرضه وخياراته وتقييماته وأسئلته — تُستعاد كما كانت بالمعرّفات نفسها */
export interface ProductSnapshot {
  product: Record<string, unknown>;
  images: Record<string, unknown>[];
  variants: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  questions: Record<string, unknown>[];
}

/** روابط الصور في لقطة — كي لا يحذفها منظّف الصور ما دامت في السلة */
export function snapshotImages(data: unknown): string[] {
  const d = data as Partial<ProductSnapshot> | null;
  if (!d?.product) return [];
  return [
    d.product.image as string,
    ...(d.images ?? []).map((i) => i.url as string),
    ...(d.variants ?? []).map((v) => v.image as string),
  ].filter((u) => typeof u === 'string' && !!u);
}
