import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const COUPON_KINDS = ['percent', 'amount', 'ship'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

/** الرمز: حروف لاتينية وأرقام وشرطة — يُحفظ بأحرف كبيرة ويُقارن كذلك */
export const COUPON_CODE = /^[A-Za-z0-9_-]{3,24}$/;

export class CouponDto {
  @IsOptional() @IsString() @Matches(COUPON_CODE, { message: 'الرمز من ٣ إلى ٢٤ حرفًا لاتينيًا أو رقمًا بلا مسافات' })
  code?: string;

  @IsOptional() @IsIn(COUPON_KINDS as unknown as string[]) kind?: CouponKind;

  /** نسبة 1..100 أو مبلغ — يُتجاهل في «توصيل مجاني» */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) value?: number;

  @IsOptional() @IsInt() @Min(0) minSubtotal?: number;
  /** سقف الخصم للنسبة — 0 بلا سقف */
  @IsOptional() @IsInt() @Min(0) maxDiscount?: number;
  /** مجموع مرات الاستخدام — 0 بلا حد */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) usageLimit?: number;
  /** لكل رقم جوال — 0 بلا حد */
  @IsOptional() @IsInt() @Min(0) @Max(1000) perCustomer?: number;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startsAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() endsAt?: string | null;

  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

/** فحص رمز من واجهة المتجر قبل الطلب — للمعاينة فقط؛ الطلب يعيد الحساب */
export class CheckCouponDto {
  @IsString() @Length(1, 24) code!: string;
  @IsOptional() @IsInt() @Min(0) subtotal?: number;
  @IsOptional() @IsInt() @Min(0) delivery?: number;
}
