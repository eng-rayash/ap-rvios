-- خيارات محفوظة
CREATE TABLE "shop_option_sets" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_option_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shop_option_sets_store_id_name_key" ON "shop_option_sets"("store_id", "name");
