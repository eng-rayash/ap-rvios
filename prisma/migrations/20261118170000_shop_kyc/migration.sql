-- توثيق المتجر
CREATE TABLE "shop_kyc" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'person',
    "legal_name" TEXT NOT NULL DEFAULT '',
    "cr_number" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "review_note" TEXT NOT NULL DEFAULT '',
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_kyc_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "shop_kyc_docs" (
    "id" TEXT NOT NULL,
    "kyc_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_kyc_docs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shop_kyc_store_id_key" ON "shop_kyc"("store_id");
CREATE INDEX "shop_kyc_status_submitted_at_idx" ON "shop_kyc"("status", "submitted_at");
CREATE INDEX "shop_kyc_docs_kyc_id_idx" ON "shop_kyc_docs"("kyc_id");
ALTER TABLE "shop_kyc" ADD CONSTRAINT "shop_kyc_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_kyc_docs" ADD CONSTRAINT "shop_kyc_docs_kyc_id_fkey" FOREIGN KEY ("kyc_id") REFERENCES "shop_kyc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
