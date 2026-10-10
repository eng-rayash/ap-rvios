import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** معرّف المتجر في منصة المتاجر — نصّ قصير (رقم أو UUID). */
const STORE_REF = /^[A-Za-z0-9_-]{1,64}$/;

export class EnsureSubscriptionDto {
  @IsOptional()
  @IsString()
  @Length(0, 120)
  storeName?: string;
}

export class CreateShopInvoiceDto {
  @IsString()
  @Length(1, 64)
  storeRef!: string;

  /** 0=اشتراك · 1=بناء متجر · 2=دومين · 3=متجر إضافي · 4=قالب */
  @IsInt()
  @IsIn([0, 1, 2, 3, 4])
  kind!: number;

  /** معرّف القالب لفواتير القوالب (kind=4) */
  @IsOptional()
  @IsString()
  @Length(1, 20)
  template?: string;

  @IsOptional()
  @IsIn(['plus', 'pro'])
  plan?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number;
}

export class SubmitProofDto {
  @IsOptional()
  @IsIn(['kuraimi', 'jaib', 'paypal'])
  method?: string;

  @IsString()
  @Length(1, 300)
  proofKey!: string;
}

export class UpdateStoreSubscriptionDto {
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  status?: number;

  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  plan?: number;

  @IsOptional()
  @IsInt()
  @Min(-3650)
  @Max(3650)
  extendDays?: number;
}

export class MarkNotifiedDto {
  @IsIn(['d7', 'd1', 'grace', 'expired'])
  stage!: string;
}

export class UpdatePlatformSettingsDto {
  /** مفاتيح حرة تُرشَّح داخل الخدمة بالقائمة البيضاء. */
  @IsObject()
  values!: Record<string, unknown>;
}

export { STORE_REF };
