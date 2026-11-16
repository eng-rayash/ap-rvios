-- مصدر الطلب: من واجهة المتجر أو يدوي من التاجر
ALTER TABLE "shop_orders" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'store';
