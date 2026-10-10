-- AlterTable
ALTER TABLE "shop_stores" ADD COLUMN     "custom_domain" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "shop_stores_custom_domain_key" ON "shop_stores"("custom_domain");

