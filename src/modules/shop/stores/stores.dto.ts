import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const HEX = /^#[0-9A-Fa-f]{6}$/;

export class CreateStoreDto {
  @IsString()
  @Length(2, 60)
  name!: string;

  /** اختياري — يُشتقّ من الاسم إن غاب */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  slug?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  /** رقم واتساب المتجر — يُوحَّد إلى E.164 بدولة المتجر */
  @IsString()
  @MaxLength(30)
  whatsapp!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tagline?: string;

  @IsOptional()
  @Matches(HEX)
  color?: string;

  @IsOptional()
  @Matches(HEX)
  colorDeep?: string;
}

export class UpdateStoreDto {
  @IsOptional() @IsString() @Length(2, 60) name?: string;
  @IsOptional() @IsString() @MaxLength(120) tagline?: string;
  @IsOptional() @IsString() @MaxLength(600) about?: string;
  @IsOptional() @IsString() @MaxLength(40) city?: string;
  @IsOptional() @IsString() @MaxLength(120) address?: string;
  @IsOptional() @IsString() @MaxLength(120) hours?: string;
  @IsOptional() @IsString() @MaxLength(600) logo?: string;
  @IsOptional() @IsString() @MaxLength(600) banner?: string;
  @IsOptional() @IsString() @MaxLength(600) showcase?: string;
  @IsOptional() @IsString() sector?: string;
  @IsOptional() @Matches(HEX) color?: string;
  @IsOptional() @Matches(HEX) colorDeep?: string;
  @IsOptional() @IsString() @MaxLength(20) theme?: string;
  @IsOptional() @IsString() @MaxLength(20) layout?: string;
  /** قالب منصة المتاجر الجديدة — معرّف من `STORE_TEMPLATES` */
  @IsOptional() @IsString() @MaxLength(20) template?: string;
  /** نطاق خاص (للباقات المدفوعة) — فارغ يزيله */
  @IsOptional() @IsString() @MaxLength(253) customDomain?: string;
  @IsOptional() @IsString() @Length(2, 2) country?: string;
  @IsOptional() @IsString() @MaxLength(30) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(60) slug?: string;

  @IsOptional() @IsInt() @Min(0) deliveryFee?: number;
  @IsOptional() @IsInt() @Min(0) deliveryFreeOver?: number;
  @IsOptional() @IsString() @MaxLength(200) deliveryNote?: string;

  @IsOptional()
  @IsArray()
  @IsIn(['cod', 'wallet', 'bank'], { each: true })
  payMethods?: string[];

  @IsOptional() @IsString() @MaxLength(400) payNote?: string;
}

/** إيقاف/رفع إيقاف — يستعمله فريق المنصة فقط. */
export class SetStoreStatusDto {
  @IsBoolean()
  suspended!: boolean;
}
