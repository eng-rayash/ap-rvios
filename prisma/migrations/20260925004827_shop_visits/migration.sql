-- CreateTable
CREATE TABLE "shop_visits" (
    "company_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shop_visits_pkey" PRIMARY KEY ("store_id","day")
);

-- CreateTable
CREATE TABLE "shop_visit_marks" (
    "mark" TEXT NOT NULL,
    "day" TEXT NOT NULL,

    CONSTRAINT "shop_visit_marks_pkey" PRIMARY KEY ("mark")
);

-- CreateIndex
CREATE INDEX "shop_visits_company_id_idx" ON "shop_visits"("company_id");

-- CreateIndex
CREATE INDEX "shop_visit_marks_day_idx" ON "shop_visit_marks"("day");
