-- AlterTable
ALTER TABLE "shop_stores" ADD COLUMN     "appearance" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "appearance_locked_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "google_sub" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

