import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Min } from 'class-validator';

export class CreateProjectCategoryDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsString()
  @Length(1, 120)
  nameEn!: string;

  @Matches(/^[\p{L}\p{N}-]+$/u, { message: 'الرابط أحرف وأرقام وشرطات فقط، بلا مسافات' })
  @Length(1, 160)
  slug!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class UpdateProjectCategoryDto extends PartialType(
  OmitType(CreateProjectCategoryDto, ['syncId'] as const),
) {}
