-- CreateTable
CREATE TABLE "shop_reviews" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reply" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_reviews_sync_id_key" ON "shop_reviews"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_reviews_order_item_id_key" ON "shop_reviews"("order_item_id");

-- CreateIndex
CREATE INDEX "shop_reviews_store_id_status_idx" ON "shop_reviews"("store_id", "status");

-- CreateIndex
CREATE INDEX "shop_reviews_product_id_status_idx" ON "shop_reviews"("product_id", "status");

-- AddForeignKey
ALTER TABLE "shop_reviews" ADD CONSTRAINT "shop_reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "shop_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
