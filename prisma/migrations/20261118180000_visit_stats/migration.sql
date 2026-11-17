-- تقرير الزوار: الصفحات المعروضة ومجاميع الأبعاد
ALTER TABLE "shop_visits" ADD COLUMN "views" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "shop_visit_stats" (
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "dim" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shop_visit_stats_pkey" PRIMARY KEY ("store_id","day","dim","key")
);
CREATE INDEX "shop_visit_stats_company_id_idx" ON "shop_visit_stats"("company_id");
