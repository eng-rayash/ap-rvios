-- المرتجعات (والطلب المُرجَع حالة رقمية جديدة 6 لعمود status)
CREATE TABLE "shop_returns" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "refund" INTEGER NOT NULL DEFAULT 0,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'customer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_returns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_returns_store_id_status_idx" ON "shop_returns"("store_id", "status");
CREATE INDEX "shop_returns_order_id_idx" ON "shop_returns"("order_id");
ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
