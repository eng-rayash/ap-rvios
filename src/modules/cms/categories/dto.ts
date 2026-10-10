import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsString, IsUUID, Length, Matches, IsOptional } from 'class-validator';

export class CreateCategoryDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsString()
  @Length(1, 120)
  nameEn!: string;

  // حروف (عربية أو لاتينية) وأرقام وشرطات فقط — لا مسافات ولا رموز.
  // عربية عمدًا: أغلب عناوين هذا الموقع عربية، وفرض لاتينية فقط يعني
  // أن كل رابط يحتاج ترجمة يدوية لا يهتمّ بها أحد فعليًا.
  @Matches(/^[\p{L}\p{N}-]+$/u, { message: 'الرابط أحرف وأرقام وشرطات فقط، بلا مسافات' })
  @Length(1, 160)
  slug!: string;
}

export class UpdateCategoryDto extends PartialType(
  OmitType(CreateCategoryDto, ['syncId'] as const),
) {}
