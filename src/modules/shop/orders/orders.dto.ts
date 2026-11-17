import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderLineDto {
  @IsUUID()
  id!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsInt()
  @Min(1)
  @Max(99)
  qty!: number;
}

/** طلب من واجهة المتجر العامة — الأسعار تُقرأ من القاعدة لا من هنا. */
export class PlaceOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];

  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsString() @MaxLength(12) payMethod?: string;
  /** رمز الخصم — يُتحقق منه ويُحسب على الخادم */
  @IsOptional() @IsString() @MaxLength(24) coupon?: string;
}

/**
 * طلب يدخله التاجر (هاتف، واتساب، زبون في المحل) — نفس محرك طلب المتجر: الأسعار من القاعدة،
 * والمخزون يُحجز، والقسيمة تُحسب في الخادم. وما يخص التاجر وحده هنا.
 */
export class ManualOrderDto extends PlaceOrderDto {
  /** رسم توصيل يحدده التاجر (يتجاوز رسم المنطقة) */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) deliveryFee?: number;
  /** خصم يدوي إضافي بالمبلغ */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) extraDiscount?: number;
  /** الدفع مُستلم فعلًا (نقدًا في المحل أو تحويلًا وصل) */
  @IsOptional() @IsBoolean() paid?: boolean;
  /** يُخصم من رصيد مكافآت العميل (برقمه) */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) pointsUsed?: number;
  /** يبدأ «مؤكدًا» (الافتراضي) — التاجر هو من أخذ الطلب */
  @IsOptional() @IsBoolean() confirm?: boolean;
}

export class AdvanceOrderDto {
  /** 1=مؤكد · 4=قيد التجهيز · 5=تم الشحن · 2=مكتمل · 3=ملغى */
  @IsInt()
  @IsIn([1, 2, 3, 4, 5])
  status!: number;

  /** سبب الإلغاء (يراه العميل في تتبّع طلبه) */
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class OrderPaymentDto {
  @IsBoolean()
  paid!: boolean;
}

export class ZoneDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsInt() @Min(0) fee?: number;
  @IsOptional() @IsInt() @Min(0) freeOver?: number;
  @IsOptional() @IsInt() sort?: number;
}
