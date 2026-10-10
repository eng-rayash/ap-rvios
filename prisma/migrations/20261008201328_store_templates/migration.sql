-- AlterTable
ALTER TABLE "platform_invoices" ADD COLUMN     "item" TEXT;

-- AlterTable
ALTER TABLE "shop_stores" ADD COLUMN     "owned_templates" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "template" TEXT NOT NULL DEFAULT 'essential';
