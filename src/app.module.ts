import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { TenantPrismaService } from './common/prisma/tenant-prisma.service';
import { JwtAuthGuard } from './common/tenant/jwt-auth.guard';
import { TenantGuard } from './common/tenant/tenant.guard';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { JwtStrategy } from './modules/auth/jwt.strategy';
import { ClientsController } from './modules/clients/clients.controller';
import { ClientsService } from './modules/clients/clients.service';
import { InvoicesController } from './modules/invoices/invoices.controller';
import { InvoicesService } from './modules/invoices/invoices.service';
import { MeetingsController } from './modules/meetings/meetings.controller';
import { MeetingsService } from './modules/meetings/meetings.service';
import { OrganizationsController } from './modules/platform-admin/organizations.controller';
import { OrganizationsService } from './modules/platform-admin/organizations.service';
import { PlatformInvoicesController } from './modules/platform-admin/platform-invoices.controller';
import { PlatformInvoicesService } from './modules/platform-admin/platform-invoices.service';
import { PlatformMeController } from './modules/platform-admin/platform-me.controller';
import { PlatformOverviewController } from './modules/platform-admin/platform-overview.controller';
import { UploadsController } from './modules/uploads/uploads.controller';
import { UploadsService } from './modules/uploads/uploads.service';
import { StoreImagesGc } from './modules/uploads/store-images-gc.service';
import { ShopReviewsController } from './modules/shop/reviews/reviews.controller';
import { ShopReviewsService } from './modules/shop/reviews/reviews.service';
import { ApiKeysController } from './modules/developers/api-keys.controller';
import { ApiKeysService } from './modules/developers/api-keys.service';
import { WebhooksController } from './modules/webhooks/webhooks.controller';
import { MerchantNotifier } from './modules/notify/merchant-notifier.service';
import { SubscriptionReminders } from './modules/notify/subscription-reminders.service';
import { WebhooksService } from './modules/webhooks/webhooks.service';
import { WorkspaceController } from './modules/workspace/workspace.controller';
import { ActivityController, NotificationsController, WorkController } from './modules/work/work.controller';
import { ActivityService } from './modules/work/activity.service';
import { NotificationsService } from './modules/work/notifications.service';
import { PeopleService } from './modules/work/people.service';
import { WorkProjectsService } from './modules/work/projects.service';
import { TasksService } from './modules/work/tasks.service';
import { AnalyticsController } from './modules/shop/analytics/analytics.controller';
import { AnalyticsService } from './modules/shop/analytics/analytics.service';
import { CatalogController } from './modules/shop/catalog/catalog.controller';
import { CatalogService } from './modules/shop/catalog/catalog.service';
import { OrdersController } from './modules/shop/orders/orders.controller';
import { OrdersService } from './modules/shop/orders/orders.service';
import { ZonesService } from './modules/shop/orders/zones.service';
import { ShopPublicController } from './modules/shop/public/public.controller';
import { ShopPublicService } from './modules/shop/public/public.service';
import { PublicRateLimit } from './modules/shop/public/rate-limit';
import { ShopStoreAccessService } from './modules/shop/shop-store-access.service';
import { PlatformStoresController, StoresController } from './modules/shop/stores/stores.controller';
import { StoresService } from './modules/shop/stores/stores.service';
import { PlatformSettingsService } from './modules/shop-billing/platform-settings.service';
import { PlatformShopBillingController } from './modules/shop-billing/platform-shop-billing.controller';
import { ShopBillingController } from './modules/shop-billing/shop-billing.controller';
import { ShopInvoicesService } from './modules/shop-billing/shop-invoices.service';
import { StoreSubscriptionsService } from './modules/shop-billing/store-subscriptions.service';
import { CategoriesController } from './modules/cms/categories/categories.controller';
import { CategoriesService } from './modules/cms/categories/categories.service';
import { PostsController } from './modules/cms/posts/posts.controller';
import { PostsService } from './modules/cms/posts/posts.service';
import { CmsServicesController } from './modules/cms/services/services.controller';
import { CmsServicesService } from './modules/cms/services/services.service';
import { ProjectCategoriesController } from './modules/cms/project-categories/project-categories.controller';
import { ProjectCategoriesService } from './modules/cms/project-categories/project-categories.service';
import { ProjectsController } from './modules/cms/projects/projects.controller';
import { ProjectsService } from './modules/cms/projects/projects.service';
import { MediaController } from './modules/cms/media/media.controller';
import { MediaService } from './modules/cms/media/media.service';
import { ContactsController } from './modules/cms/contacts/contacts.controller';
import { AppConfigController } from './modules/shop-billing/app-config.controller';
import { HealthController, RootController } from './modules/health/health.controller';
import { ContactsService } from './modules/cms/contacts/contacts.service';
import { SettingsController } from './modules/cms/settings/settings.controller';
import { SettingsService } from './modules/cms/settings/settings.service';

/**
 * AZM — الوحدة الجذر
 *
 * قرار معماري واحد يستحقّ الانتباه: [TenantGuard] مُسجَّل حارسًا
 * **عامًّا** لا على مسارات مختارة.
 *
 * السبب: الحماية الافتراضية يجب أن تكون المنع لا السماح. لو سُجِّل
 * على المسارات فرادى، لكان كل مسار جديد مفتوحًا حتى يتذكّر كاتبه
 * إضافة الحارس — والنسيان هنا ثغرة صامتة. الآن العكس: المسار مغلق
 * حتى يُعلَّم بـ`@Public()` صراحةً، والسهو يُنتج مسارًا لا يعمل لا
 * مسارًا مكشوفًا.
 *
 * [JwtAuthGuard] مُسجَّل قبله للسبب نفسه، والترتيب ملزِم: Nest ينفّذ
 * حرّاس `APP_GUARD` بترتيب تسجيلهم، و[TenantGuard] يقرأ `req.user`
 * الذي يملؤه الأول.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PassportModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        // `!` مبرَّر: JwtStrategy يفشل عند الإقلاع إن غاب السرّ،
        // فلا يصل التطبيق إلى هنا بقيمة فارغة.
        secret: config.get<string>('JWT_SECRET')!,
        signOptions: {
          // `expiresIn` في jsonwebtoken يقبل عددًا أو صيغة مدّة
          // (`7d`)، ونوعه الضيّق لا يُستنتج من `string`.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '7d') as `${number}d`,
        },
      }),
    }),
  ],
  controllers: [
    RootController,
    HealthController,
    AuthController,
    MeetingsController,
    ClientsController,
    InvoicesController,
    OrganizationsController,
    PlatformInvoicesController,
    PlatformMeController,
    PlatformOverviewController,
    WorkspaceController,
    UploadsController,
    ApiKeysController,
    WebhooksController,
    WorkController,
    NotificationsController,
    ActivityController,
    ShopBillingController,
    PlatformShopBillingController,
    StoresController,
    PlatformStoresController,
    CatalogController,
    OrdersController,
    AnalyticsController,
    ShopPublicController,
    CategoriesController,
    PostsController,
    CmsServicesController,
    ProjectCategoriesController,
    ProjectsController,
    MediaController,
    ContactsController,
    AppConfigController,
    ShopReviewsController,
    SettingsController,
  ],
  providers: [
    TenantPrismaService,
    PeopleService,
    UploadsService,
    StoreImagesGc,
    ShopReviewsService,
    ApiKeysService,
    WebhooksService,
    MerchantNotifier,
    SubscriptionReminders,
    ActivityService,
    NotificationsService,
    WorkProjectsService,
    TasksService,
    JwtStrategy,
    AuthService,
    MeetingsService,
    ClientsService,
    InvoicesService,
    OrganizationsService,
    PlatformInvoicesService,
    PlatformSettingsService,
    StoreSubscriptionsService,
    ShopInvoicesService,
    ShopStoreAccessService,
    StoresService,
    CatalogService,
    OrdersService,
    ZonesService,
    AnalyticsService,
    ShopPublicService,
    PublicRateLimit,
    CategoriesService,
    PostsService,
    CmsServicesService,
    ProjectCategoriesService,
    ProjectsService,
    MediaService,
    ContactsService,
    SettingsService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
})
export class AppModule {}
