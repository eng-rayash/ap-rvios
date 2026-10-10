import { OmitType, PartialType } from '@nestjs/mapped-types';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreatePostDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  titleEn?: string;

  @Matches(/^[\p{L}\p{N}-]+$/u, { message: 'الرابط أحرف وأرقام وشرطات فقط، بلا مسافات' })
  @Length(1, 200)
  slug!: string;

  @IsString()
  @Length(1, 300)
  description!: string;

  @IsString()
  content!: string;

  @IsString()
  @Length(1, 300)
  metaDescription!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  heroImageUrl?: string;

  @IsOptional()
  @IsString()
  heroImageAlt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  readingTime?: number;

  // 0=مسودة · 1=منشورة
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  status?: number;

  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @IsUUID()
  categoryId!: string;
}

export class UpdatePostDto extends PartialType(
  OmitType(CreatePostDto, ['syncId', 'categoryId'] as const),
) {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
