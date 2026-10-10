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
}

export class AdvanceOrderDto {
  /** 1=مؤكد · 2=مكتمل · 3=ملغى */
  @IsInt()
  @IsIn([1, 2, 3])
  status!: number;
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
