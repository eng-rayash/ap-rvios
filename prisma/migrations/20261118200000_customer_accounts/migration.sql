-- حسابات العملاء ومحافظهم وإشعاراتهم
ALTER TABLE "shop_customers" ADD COLUMN "wallet" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shop_customers" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "shop_orders" ADD COLUMN "wallet_paid" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "shop_wallet_tx" (
    "id" TEXT NOT NULL, "company_id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "customer_id" TEXT NOT NULL, "order_id" TEXT,
    "amount" INTEGER NOT NULL, "kind" TEXT NOT NULL, "note" TEXT NOT NULL DEFAULT '', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_wallet_tx_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_wallet_tx_customer_id_created_at_idx" ON "shop_wallet_tx"("customer_id", "created_at");
CREATE INDEX "shop_wallet_tx_order_id_idx" ON "shop_wallet_tx"("order_id");
CREATE TABLE "shop_notices" (
    "id" TEXT NOT NULL, "company_id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "customer_id" TEXT NOT NULL, "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL, "body" TEXT NOT NULL DEFAULT '', "link" TEXT NOT NULL DEFAULT '', "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_notices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_notices_customer_id_created_at_idx" ON "shop_notices"("customer_id", "created_at");
CREATE TABLE "shop_broadcasts" (
    "id" TEXT NOT NULL, "company_id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT NOT NULL,
    "link" TEXT NOT NULL DEFAULT '', "audience" TEXT NOT NULL, "recipients" INTEGER NOT NULL DEFAULT 0, "sent" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_broadcasts_store_id_created_at_idx" ON "shop_broadcasts"("store_id", "created_at");
CREATE TABLE "shop_customer_otps" (
    "id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "phone" TEXT NOT NULL, "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0, "expires_at" TIMESTAMP(3) NOT NULL, "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_customer_otps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shop_customer_otps_store_id_phone_created_at_idx" ON "shop_customer_otps"("store_id", "phone", "created_at");
