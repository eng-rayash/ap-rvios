-- CreateTable
CREATE TABLE "shop_stores" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" TEXT NOT NULL DEFAULT 'other',
    "tagline" TEXT NOT NULL DEFAULT '',
    "about" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "whatsapp" TEXT NOT NULL DEFAULT '',
    "hours" TEXT NOT NULL DEFAULT '',
    "logo" TEXT NOT NULL DEFAULT '',
    "banner" TEXT NOT NULL DEFAULT '',
    "showcase" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#9E2226',
    "color_deep" TEXT NOT NULL DEFAULT '#6E1519',
    "theme" TEXT NOT NULL DEFAULT 'signature',
    "layout" TEXT NOT NULL DEFAULT 'signature',
    "country" TEXT NOT NULL DEFAULT 'YE',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "status" INTEGER NOT NULL DEFAULT 0,
    "delivery_fee" INTEGER NOT NULL DEFAULT 0,
    "delivery_free_over" INTEGER NOT NULL DEFAULT 0,
    "delivery_note" TEXT NOT NULL DEFAULT '',
    "pay_methods" TEXT NOT NULL DEFAULT 'cod',
    "pay_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_slug_history" (
    "old_slug" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_slug_history_pkey" PRIMARY KEY ("old_slug")
);

-- CreateTable
CREATE TABLE "shop_categories" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shop_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_products" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "category_id" TEXT,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "variant" TEXT NOT NULL DEFAULT '',
    "brand" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "old_price" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "low_stock" INTEGER NOT NULL DEFAULT 0,
    "image" TEXT NOT NULL DEFAULT '',
    "live" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "has_variants" BOOLEAN NOT NULL DEFAULT false,
    "opt1_name" TEXT NOT NULL DEFAULT '',
    "opt2_name" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_product_images" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shop_product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_product_variants" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "v1" TEXT NOT NULL DEFAULT '',
    "v2" TEXT NOT NULL DEFAULT '',
    "price" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "sku" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "live" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shop_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_customers" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "first_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_delivery_zones" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "free_over" INTEGER NOT NULL DEFAULT 0,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shop_delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_orders" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "customer_id" TEXT,
    "zone_id" TEXT,
    "zone_name" TEXT NOT NULL DEFAULT '',
    "pay_method" TEXT NOT NULL DEFAULT 'cod',
    "pay_status" INTEGER NOT NULL DEFAULT 0,
    "pay_proof" TEXT NOT NULL DEFAULT '',
    "cust_name" TEXT NOT NULL DEFAULT '',
    "cust_phone" TEXT NOT NULL DEFAULT '',
    "cust_address" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "subtotal" INTEGER NOT NULL,
    "delivery_fee" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_order_items" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT,
    "variant_id" TEXT,
    "name" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "shop_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_stores_slug_key" ON "shop_stores"("slug");

-- CreateIndex
CREATE INDEX "shop_stores_company_id_idx" ON "shop_stores"("company_id");

-- CreateIndex
CREATE INDEX "shop_slug_history_store_id_idx" ON "shop_slug_history"("store_id");

-- CreateIndex
CREATE INDEX "shop_categories_store_id_sort_idx" ON "shop_categories"("store_id", "sort");

-- CreateIndex
CREATE INDEX "shop_products_store_id_live_idx" ON "shop_products"("store_id", "live");

-- CreateIndex
CREATE INDEX "shop_products_store_id_brand_idx" ON "shop_products"("store_id", "brand");

-- CreateIndex
CREATE INDEX "shop_product_images_product_id_sort_idx" ON "shop_product_images"("product_id", "sort");

-- CreateIndex
CREATE INDEX "shop_product_variants_product_id_sort_idx" ON "shop_product_variants"("product_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "shop_product_variants_product_id_v1_v2_key" ON "shop_product_variants"("product_id", "v1", "v2");

-- CreateIndex
CREATE INDEX "shop_customers_store_id_last_at_idx" ON "shop_customers"("store_id", "last_at");

-- CreateIndex
CREATE UNIQUE INDEX "shop_customers_store_id_phone_key" ON "shop_customers"("store_id", "phone");

-- CreateIndex
CREATE INDEX "shop_delivery_zones_store_id_sort_idx" ON "shop_delivery_zones"("store_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_ref_key" ON "shop_orders"("ref");

-- CreateIndex
CREATE INDEX "shop_orders_store_id_status_created_at_idx" ON "shop_orders"("store_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "shop_order_items_order_id_idx" ON "shop_order_items"("order_id");

-- CreateIndex
CREATE INDEX "shop_order_items_store_id_product_id_idx" ON "shop_order_items"("store_id", "product_id");

-- AddForeignKey
ALTER TABLE "shop_stores" ADD CONSTRAINT "shop_stores_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_slug_history" ADD CONSTRAINT "shop_slug_history_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_categories" ADD CONSTRAINT "shop_categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_categories" ADD CONSTRAINT "shop_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "shop_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "shop_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_product_images" ADD CONSTRAINT "shop_product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "shop_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_product_variants" ADD CONSTRAINT "shop_product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "shop_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_customers" ADD CONSTRAINT "shop_customers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_delivery_zones" ADD CONSTRAINT "shop_delivery_zones_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "shop_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_items" ADD CONSTRAINT "shop_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
