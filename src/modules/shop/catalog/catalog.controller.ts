import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { RequireRole, Tenant } from '../../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../../common/tenant/tenant-context';
import { CatalogService } from './catalog.service';
import { CreateCategoryDto, ProductDto, UpdateCategoryDto } from './catalog.dto';

/** كتالوج متجر — تصنيفات ومنتجات. الكتابة لمدير الأقسام فما فوق. */
@Controller('shop/stores/:storeId')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── التصنيفات ───────────────────────────────────────────
  @Get('categories')
  categories(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.catalog.listCategories(ctx, storeId);
  }

  @RequireRole(UserRole.DeptManager)
  @Post('categories')
  createCategory(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.catalog.createCategory(ctx, storeId, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Patch('categories/:id')
  updateCategory(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete('categories/:id')
  removeCategory(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.removeCategory(ctx, storeId, id);
  }

  // ── المنتجات ────────────────────────────────────────────
  @Get('products')
  products(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    return this.catalog.listProducts(ctx, storeId);
  }

  @Get('products/:id')
  product(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.getProduct(ctx, storeId, id);
  }

  @RequireRole(UserRole.DeptManager)
  @Post('products')
  createProduct(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: ProductDto,
  ) {
    return this.catalog.createProduct(ctx, storeId, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Patch('products/:id')
  updateProduct(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProductDto,
  ) {
    return this.catalog.updateProduct(ctx, storeId, id, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete('products/:id')
  removeProduct(
    @Tenant() ctx: TenantContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.removeProduct(ctx, storeId, id);
  }
}
