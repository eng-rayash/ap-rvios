-- برنامج المكافآت
ALTER TABLE "shop_stores" ADD COLUMN "loyalty_rate" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shop_customers" ADD COLUMN "points" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "shop_points_tx" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "order_id" TEXT,
    "amount" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_points_tx_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_points_tx_customer_id_created_at_idx" ON "shop_points_tx"("customer_id", "created_at");
CREATE INDEX "shop_points_tx_order_id_idx" ON "shop_points_tx"("order_id");
