-- أسئلة المنتجات
CREATE TABLE "shop_questions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),

    CONSTRAINT "shop_questions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_questions_store_id_status_idx" ON "shop_questions"("store_id", "status");
CREATE INDEX "shop_questions_product_id_status_idx" ON "shop_questions"("product_id", "status");
ALTER TABLE "shop_questions" ADD CONSTRAINT "shop_questions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "shop_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
