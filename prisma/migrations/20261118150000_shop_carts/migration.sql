-- السلات المتروكة
CREATE TABLE "shop_carts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "recovered_order_id" TEXT,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_carts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shop_carts_store_id_phone_key" ON "shop_carts"("store_id", "phone");
CREATE INDEX "shop_carts_store_id_status_updated_at_idx" ON "shop_carts"("store_id", "status", "updated_at");
