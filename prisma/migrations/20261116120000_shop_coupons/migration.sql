-- قسائم الخصم
CREATE TABLE "shop_coupons" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'percent',
    "value" INTEGER NOT NULL DEFAULT 0,
    "min_subtotal" INTEGER NOT NULL DEFAULT 0,
    "max_discount" INTEGER NOT NULL DEFAULT 0,
    "usage_limit" INTEGER NOT NULL DEFAULT 0,
    "per_customer" INTEGER NOT NULL DEFAULT 0,
    "used" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_coupons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_coupons_store_id_code_key" ON "shop_coupons"("store_id", "code");
CREATE INDEX "shop_coupons_store_id_active_idx" ON "shop_coupons"("store_id", "active");
ALTER TABLE "shop_coupons" ADD CONSTRAINT "shop_coupons_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- الطلب يحفظ القسيمة وقيمة الخصم
ALTER TABLE "shop_orders" ADD COLUMN "coupon_code" TEXT NOT NULL DEFAULT '';
ALTER TABLE "shop_orders" ADD COLUMN "discount" INTEGER NOT NULL DEFAULT 0;
