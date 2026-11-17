-- شركات الشحن ورقم التتبّع
ALTER TABLE "shop_orders" ADD COLUMN "carrier_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "shop_orders" ADD COLUMN "tracking_no" TEXT NOT NULL DEFAULT '';
ALTER TABLE "shop_orders" ADD COLUMN "track_url" TEXT NOT NULL DEFAULT '';
ALTER TABLE "shop_orders" ADD COLUMN "track_url_template" TEXT NOT NULL DEFAULT '';
CREATE TABLE "shop_carriers" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "track_url" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_carriers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_carriers_store_id_idx" ON "shop_carriers"("store_id");
