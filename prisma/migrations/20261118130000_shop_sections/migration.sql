-- أقسام منتجات الصفحة الرئيسية
CREATE TABLE "shop_sections" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'best',
    "ref" TEXT NOT NULL DEFAULT '',
    "product_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "layout" TEXT NOT NULL DEFAULT 'grid',
    "limit" INTEGER NOT NULL DEFAULT 8,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_sections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_sections_store_id_active_sort_idx" ON "shop_sections"("store_id", "active", "sort");
