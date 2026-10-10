-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_platform_staff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "platform_role" INTEGER;

-- CreateTable
CREATE TABLE "platform_invoices" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "payment_reference" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_sync_id_key" ON "platform_invoices"("sync_id");

-- CreateIndex
CREATE INDEX "platform_invoices_status_created_at_idx" ON "platform_invoices"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_company_id_invoice_number_key" ON "platform_invoices"("company_id", "invoice_number");

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
