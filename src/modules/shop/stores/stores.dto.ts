import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
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

  /**
   * طلب بباقة مدفوعة: المتجر يُحجز بانتظار تفعيل الفريق، ومعه فاتورتا الباقة والقالب.
   * بلا `plan` يُنشأ متجرًا مجانيًا يعمل فورًا.
   */
  @IsOptional() @IsIn(['plus', 'pro']) plan?: 'plus' | 'pro';
  @IsOptional() @IsIn([1, 12]) months?: 1 | 12;
  @IsOptional() @IsString() @MaxLength(20) template?: string;

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

/** منتج في حفظ «شكل المتجر» — بلا `id` يُنشأ جديدًا */
export class AppearanceProductDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @Length(1, 100) name!: string;
  @IsInt() @Min(0) price!: number;
  @IsOptional() @IsInt() @Min(0) oldPrice?: number;
  @IsOptional() @IsString() @MaxLength(600) image?: string;
}

/**
 * إضافات المتجر خارج التصميم: شريط الإعلان، وصفحات السياسات، وزر واتساب العائم، ووصف محركات البحث.
 * محتوى يتغيّر كثيرًا (عرض الأسبوع، سياسة الشحن) فلا يخضع لقفل الأسبوع الذي يخضع له «شكل المتجر».
 */
export class SaveStoreExtrasDto {
  @IsOptional() @IsObject() announce?: { on?: boolean; text?: string; link?: string; color?: string };
  @IsOptional() @IsObject() policies?: Record<string, string>;
  @IsOptional() waFloat?: boolean;
  @IsOptional() @IsString() @MaxLength(70) seoTitle?: string;
  @IsOptional() @IsString() @MaxLength(170) seoDescription?: string;
}

export class SaveAppearanceDto {
  @IsOptional() @IsString() @Length(2, 60) name?: string;
  @IsOptional() @IsString() @MaxLength(600) logo?: string;
  @IsOptional() @IsString() @MaxLength(600) banner?: string;
  @IsOptional() @IsString() @MaxLength(600) showcase?: string;
  @IsOptional() @Matches(HEX) color?: string;
  /** نصوص القالب — الخدمة تقبل مفاتيحها المعروفة وتقصّ الطول */
  @IsOptional() @IsObject() copy?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) hidden?: string[];
  /** صورة من صور القالب (بمعرّفها) ← رابط صورة التاجر */
  @IsOptional() @IsObject() images?: Record<string, string>;
  /** خطّا الواجهة: `display` للعناوين و`body` للنصوص — معرّفات من قائمة منصة المتاجر */
  @IsOptional() @IsObject() fonts?: Record<string, string>;
  /** حسابات التواصل (اسم المستخدم أو الرابط) ومكان عرضها `placement` */
  @IsOptional() @IsObject() social?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(600) @IsUUID('all', { each: true }) deleteProducts?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AppearanceProductDto) products?: AppearanceProductDto[];
}
