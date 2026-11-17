-- سلة المحذوفات
CREATE TABLE "shop_trash" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'product',
    "ref_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_trash_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_trash_store_id_deleted_at_idx" ON "shop_trash"("store_id", "deleted_at");
