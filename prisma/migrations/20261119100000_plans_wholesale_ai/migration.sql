-- وضع الجملة والمساعد الذكي في المتجر
ALTER TABLE "shop_stores" ADD COLUMN "wholesale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "shop_stores" ADD COLUMN "ai_assistant" BOOLEAN NOT NULL DEFAULT false;
