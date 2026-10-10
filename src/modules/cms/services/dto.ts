import { OmitType, PartialType } from '@nestjs/mapped-types';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CreateServiceDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  @Length(1, 160)
  title!: string;

  @IsString()
  @Length(1, 160)
  titleEn!: string;

  @Matches(/^[\p{L}\p{N}-]+$/u, { message: 'الرابط أحرف وأرقام وشرطات فقط، بلا مسافات' })
  @Length(1, 160)
  slug!: string;

  @IsString()
  description!: string;

  @IsString()
  descriptionEn!: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  // 0=نشطة · 1=غير نشطة
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class UpdateServiceDto extends PartialType(
  OmitType(CreateServiceDto, ['syncId'] as const),
) {}
