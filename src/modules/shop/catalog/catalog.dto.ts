import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @Length(1, 40)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(1, 40) name?: string;
  @IsOptional() @IsInt() sort?: number;
}

export class VariantDto {
  /** معرّف قائم — يُطابَق به أولًا فلا تُفقد إحالات الطلبات القديمة */
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsString() @MaxLength(40) v1?: string;
  @IsOptional() @IsString() @MaxLength(40) v2?: string;
  /** null/غائب = يرث سعر المنتج */
  @IsOptional() @IsInt() @Min(0) price?: number | null;
  @IsOptional() @IsInt() @Min(0) qty?: number;
  @IsOptional() @IsString() @MaxLength(40) sku?: string;
  /** رابط صورة الخيار (http/https أو مسار نسبي) */
  @IsOptional() @IsString() @MaxLength(600) image?: string;
  @IsOptional() @IsBoolean() live?: boolean;
}

/** إنشاء/تعديل منتج — الحقول الغائبة لا تُمسّ عند التعديل. */
export class ProductDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @MaxLength(120) summary?: string;
  @IsOptional() @IsString() @MaxLength(1200) description?: string;
  @IsOptional() @IsString() @MaxLength(40) variant?: string;
  @IsOptional() @IsString() @MaxLength(60) brand?: string;
  @IsOptional() @IsString() @MaxLength(24) opt1Name?: string;
  @IsOptional() @IsString() @MaxLength(24) opt2Name?: string;

  @IsOptional() @IsInt() @Min(0) price?: number;
  /** 0 أو غائب = بلا سعر قديم */
  @IsOptional() @IsInt() @Min(0) oldPrice?: number;
  @IsOptional() @IsInt() @Min(0) qty?: number;
  @IsOptional() @IsInt() @Min(0) lowStock?: number;
  @IsOptional() @IsBoolean() live?: boolean;
  @IsOptional() @IsInt() sort?: number;

  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsOptional() @IsString() @MaxLength(600) image?: string;

  /** المعرض كاملًا (استبدال لا دمج) — الأول هو الغلاف */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  images?: string[];

  /** شبكة الخيارات كاملة (استبدال لا دمج) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  variants?: VariantDto[];
}
