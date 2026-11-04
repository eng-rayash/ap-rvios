-- CreateTable
CREATE TABLE "ai_public_usage" (
    "id" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "thoughts_tokens" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "counted" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_public_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_public_usage_created_at_idx" ON "ai_public_usage"("created_at");

-- CreateIndex
CREATE INDEX "ai_public_usage_ip_hash_created_at_idx" ON "ai_public_usage"("ip_hash", "created_at");

