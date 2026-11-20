-- محفظة التاجر لدى RVIOS، الفترة التجريبية، والإحالات
ALTER TABLE "organizations" ADD COLUMN "store_trial_used_at" TIMESTAMP(3),
  ADD COLUMN "wallet_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "referral_code" TEXT,
  ADD COLUMN "referred_by_id" TEXT,
  ADD COLUMN "referral_rewarded_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "organizations_referral_code_key" ON "organizations"("referral_code");

ALTER TABLE "store_subscriptions" ADD COLUMN "trial" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "merchant_wallet_txs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "kind" TEXT NOT NULL,
    "invoice_id" TEXT,
    "note" TEXT,
    "balance" DECIMAL(14,2) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_wallet_txs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "merchant_wallet_txs_company_id_created_at_idx" ON "merchant_wallet_txs"("company_id", "created_at");
ALTER TABLE "merchant_wallet_txs" ADD CONSTRAINT "merchant_wallet_txs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
