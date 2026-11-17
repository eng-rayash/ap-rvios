-- تذاكر الدعم بين التاجر وفريق المنصة
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL, "company_id" TEXT NOT NULL, "store_id" TEXT, "ref" TEXT NOT NULL, "subject" TEXT NOT NULL, "category" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0, "status" INTEGER NOT NULL DEFAULT 0, "created_by_id" TEXT NOT NULL,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL, "ticket_id" TEXT NOT NULL, "company_id" TEXT NOT NULL, "author_id" TEXT NOT NULL,
    "from_staff" BOOLEAN NOT NULL DEFAULT false, "body" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "support_tickets_ref_key" ON "support_tickets"("ref");
CREATE INDEX "support_tickets_company_id_status_idx" ON "support_tickets"("company_id", "status");
CREATE INDEX "support_tickets_status_last_message_at_idx" ON "support_tickets"("status", "last_message_at");
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "shop_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
