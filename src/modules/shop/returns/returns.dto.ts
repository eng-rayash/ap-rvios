import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min } from 'class-validator';

/** من صفحة تتبّع الطلب — الإثبات رقم الطلب كالتقييم */
export class RequestReturnDto {
  @IsString() @Length(5, 500) reason!: string;
}

export class CreateReturnDto {
  @IsUUID() orderId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsInt() @Min(0) refund?: number;
  /** إعادة الكميات للمخزون عند الإتمام (الافتراضي نعم) */
  @IsOptional() @IsBoolean() restock?: boolean;
  /** يُتمّ فورًا (استلم المرتجع وأعاد المبلغ) */
  @IsOptional() @IsBoolean() complete?: boolean;
}

export class UpdateReturnDto {
  /** 1 قبول · 2 رفض · 3 إتمام */
  @IsOptional() @IsInt() @IsIn([1, 2, 3]) status?: number;
  @IsOptional() @IsInt() @Min(0) refund?: number;
  @IsOptional() @IsBoolean() restock?: boolean;
  /** ملاحظة يراها العميل (سبب الرفض مثلًا) */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
