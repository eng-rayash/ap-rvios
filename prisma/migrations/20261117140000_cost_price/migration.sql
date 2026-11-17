-- سعر التكلفة للمنتج، وتكلفة الوحدة في سطر الطلب
ALTER TABLE "shop_products" ADD COLUMN "cost_price" INTEGER;
ALTER TABLE "shop_order_items" ADD COLUMN "cost" INTEGER NOT NULL DEFAULT 0;
