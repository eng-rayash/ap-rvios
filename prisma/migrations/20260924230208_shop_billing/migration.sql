-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "store_slots" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "platform_invoices" ADD COLUMN     "due_at" TIMESTAMP(3),
ADD COLUMN     "kind" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "months" INTEGER,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "plan" INTEGER,
ADD COLUMN     "proof_key" TEXT,
ADD COLUMN     "store_ref" TEXT,
ADD COLUMN     "void_reason" TEXT;

-- CreateTable
CREATE TABLE "store_subscriptions" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_ref" TEXT NOT NULL,
    "store_name" TEXT,
    "plan" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "current_period_end" TIMESTAMP(3),
    "notified_stage" TEXT,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "store_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_subscriptions_sync_id_key" ON "store_subscriptions"("sync_id");

-- CreateIndex
CREATE INDEX "store_subscriptions_status_current_period_end_idx" ON "store_subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "store_subscriptions_company_id_store_ref_key" ON "store_subscriptions"("company_id", "store_ref");

-- CreateIndex
CREATE INDEX "platform_invoices_company_id_store_ref_kind_status_idx" ON "platform_invoices"("company_id", "store_ref", "kind", "status");

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
