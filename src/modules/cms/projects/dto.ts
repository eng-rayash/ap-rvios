import { Type } from 'class-transformer';
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
  Min,
  ValidateNested,
} from 'class-validator';
import { OmitType, PartialType } from '@nestjs/mapped-types';

export class ProjectImageDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  alt?: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsInt()
  width?: number;

  @IsOptional()
  @IsInt()
  height?: number;

  @IsOptional()
  @IsString()
  blurHash?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class ProjectMetricDto {
  @IsString()
  @Length(1, 80)
  label!: string;

  @IsString()
  @Length(1, 40)
  value!: string;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  unit?: string;

  // 0=صعود · 1=هبوط · 2=محايد
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  direction?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class CreateProjectDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @Matches(/^[\p{L}\p{N}-]+$/u, { message: 'الرابط أحرف وأرقام وشرطات فقط، بلا مسافات' })
  @Length(1, 200)
  slug!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  titleEn?: string;

  @IsString()
  @Length(1, 300)
  summary!: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  challenge?: string;

  @IsOptional()
  @IsString()
  solution?: string;

  @IsOptional()
  @IsString()
  outcome?: string;

  /// [{ title, desc }] — سرد لا يُستعلَم عنه، Json خام يكفي هنا.
  @IsOptional()
  @IsArray()
  approach?: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  client?: string;

  @IsOptional()
  @IsString()
  clientLogoUrl?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsInt()
  year?: number;

  @IsOptional()
  @IsInt()
  durationMonths?: number;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsInt()
  teamSize?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  technologies?: string[];

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  serviceIds?: string[];

  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @IsOptional()
  @IsString()
  coverImageAlt?: string;

  @IsOptional()
  @IsString()
  coverBlurHash?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProjectImageDto)
  gallery?: ProjectImageDto[];

  @IsOptional()
  @IsString()
  testimonialQuote?: string;

  @IsOptional()
  @IsString()
  testimonialAuthor?: string;

  @IsOptional()
  @IsString()
  testimonialRole?: string;

  @IsOptional()
  @IsString()
  testimonialAvatarUrl?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProjectMetricDto)
  metrics?: ProjectMetricDto[];

  @IsOptional()
  @IsString()
  liveUrl?: string;

  @IsOptional()
  @IsString()
  repoUrl?: string;

  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  // 0=مسودة · 1=منشور · 2=مؤرشف
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  status?: number;

  @IsOptional()
  @IsString()
  metaTitle?: string;

  @IsOptional()
  @IsString()
  metaDescription?: string;

  @IsOptional()
  @IsString()
  ogImageUrl?: string;
}

export class UpdateProjectDto extends PartialType(
  OmitType(CreateProjectDto, ['syncId'] as const),
) {}
