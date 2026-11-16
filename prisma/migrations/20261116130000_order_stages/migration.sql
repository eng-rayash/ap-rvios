-- مراحل الطلب: قيد التجهيز (4) وتم الشحن (5) قيم جديدة لعمود status الرقمي — لا تغيير بنيوي لها
-- سبب الإلغاء
ALTER TABLE "shop_orders" ADD COLUMN "cancel_reason" TEXT NOT NULL DEFAULT '';
