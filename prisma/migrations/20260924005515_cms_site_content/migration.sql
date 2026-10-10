-- CreateTable
CREATE TABLE "cms_categories" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cms_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_posts" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_en" TEXT,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta_description" TEXT NOT NULL,
    "keywords" TEXT[],
    "tags" TEXT[],
    "hero_image_url" TEXT,
    "hero_image_alt" TEXT,
    "reading_time" INTEGER NOT NULL DEFAULT 5,
    "status" INTEGER NOT NULL DEFAULT 0,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "category_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cms_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_services" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "description_en" TEXT NOT NULL,
    "icon" TEXT,
    "features" TEXT[],
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cms_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_projects" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_en" TEXT,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "challenge" TEXT,
    "solution" TEXT,
    "outcome" TEXT,
    "approach" JSONB NOT NULL DEFAULT '[]',
    "client" TEXT,
    "client_logo_url" TEXT,
    "industry" TEXT,
    "year" INTEGER,
    "duration_months" INTEGER,
    "role" TEXT,
    "team_size" INTEGER,
    "technologies" TEXT[],
    "category_id" TEXT,
    "cover_image_url" TEXT,
    "cover_image_alt" TEXT,
    "cover_blur_hash" TEXT,
    "testimonial_quote" TEXT,
    "testimonial_author" TEXT,
    "testimonial_role" TEXT,
    "testimonial_avatar_url" TEXT,
    "live_url" TEXT,
    "repo_url" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "meta_title" TEXT,
    "meta_description" TEXT,
    "og_image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cms_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_project_images" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "caption" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "blur_hash" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cms_project_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_project_metrics" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT,
    "direction" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cms_project_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_project_categories" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cms_project_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_project_services" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,

    CONSTRAINT "cms_project_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_media" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cms_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_contacts" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "service" TEXT,
    "message" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cms_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_settings" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cms_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_owner_profiles" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_en" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "bio_en" TEXT NOT NULL,
    "avatar_url" TEXT,
    "skills" TEXT[],
    "links" JSONB NOT NULL DEFAULT '{}',
    "resume_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cms_owner_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cms_categories_sync_id_key" ON "cms_categories"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_categories_company_id_slug_key" ON "cms_categories"("company_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cms_posts_sync_id_key" ON "cms_posts"("sync_id");

-- CreateIndex
CREATE INDEX "cms_posts_company_id_status_published_at_idx" ON "cms_posts"("company_id", "status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "cms_posts_company_id_slug_key" ON "cms_posts"("company_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cms_services_sync_id_key" ON "cms_services"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_services_company_id_slug_key" ON "cms_services"("company_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cms_projects_sync_id_key" ON "cms_projects"("sync_id");

-- CreateIndex
CREATE INDEX "cms_projects_company_id_status_featured_order_idx" ON "cms_projects"("company_id", "status", "featured", "order");

-- CreateIndex
CREATE UNIQUE INDEX "cms_projects_company_id_slug_key" ON "cms_projects"("company_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cms_project_images_sync_id_key" ON "cms_project_images"("sync_id");

-- CreateIndex
CREATE INDEX "cms_project_images_project_id_order_idx" ON "cms_project_images"("project_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "cms_project_metrics_sync_id_key" ON "cms_project_metrics"("sync_id");

-- CreateIndex
CREATE INDEX "cms_project_metrics_project_id_order_idx" ON "cms_project_metrics"("project_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "cms_project_categories_sync_id_key" ON "cms_project_categories"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_project_categories_company_id_slug_key" ON "cms_project_categories"("company_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cms_project_services_sync_id_key" ON "cms_project_services"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_project_services_company_id_project_id_service_id_key" ON "cms_project_services"("company_id", "project_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_media_sync_id_key" ON "cms_media"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_contacts_sync_id_key" ON "cms_contacts"("sync_id");

-- CreateIndex
CREATE INDEX "cms_contacts_company_id_status_created_at_idx" ON "cms_contacts"("company_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cms_settings_sync_id_key" ON "cms_settings"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_settings_company_id_key_key" ON "cms_settings"("company_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "cms_owner_profiles_sync_id_key" ON "cms_owner_profiles"("sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "cms_owner_profiles_company_id_key" ON "cms_owner_profiles"("company_id");

-- AddForeignKey
ALTER TABLE "cms_categories" ADD CONSTRAINT "cms_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_posts" ADD CONSTRAINT "cms_posts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_posts" ADD CONSTRAINT "cms_posts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "cms_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_services" ADD CONSTRAINT "cms_services_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_projects" ADD CONSTRAINT "cms_projects_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_projects" ADD CONSTRAINT "cms_projects_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "cms_project_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_images" ADD CONSTRAINT "cms_project_images_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_images" ADD CONSTRAINT "cms_project_images_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cms_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_metrics" ADD CONSTRAINT "cms_project_metrics_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_metrics" ADD CONSTRAINT "cms_project_metrics_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cms_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_categories" ADD CONSTRAINT "cms_project_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_services" ADD CONSTRAINT "cms_project_services_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_services" ADD CONSTRAINT "cms_project_services_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cms_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_project_services" ADD CONSTRAINT "cms_project_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "cms_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_media" ADD CONSTRAINT "cms_media_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_contacts" ADD CONSTRAINT "cms_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_settings" ADD CONSTRAINT "cms_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_owner_profiles" ADD CONSTRAINT "cms_owner_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
