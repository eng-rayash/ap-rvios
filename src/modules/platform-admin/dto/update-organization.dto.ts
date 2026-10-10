import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * تحديث حالة اشتراك شركة — فريق المنصة فقط.
 *
 * لا `name` ولا `companyCode` هنا: هذه بيانات الشركة نفسها، لا شأن
 * لفريق المنصة بتعديلها. النطاق مقصور على ما يخصّ الاشتراك فعلاً.
 */
export class UpdateOrganizationDto {
  // 0=تجريبي · 1=أساسي · 2=احترافي · 3=مؤسسي
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  planType?: number;

  // 0=نشط · 1=منتهي · 2=معلَّق · 3=ملغى
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  subscriptionStatus?: number;

  @IsOptional()
  @IsISO8601()
  trialEndsAt?: string;

  /// خانات المتاجر في منصة المتاجر (1..5) — تُمنح عادةً بفاتورة، وهذا للتصحيح اليدوي.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  storeSlots?: number;
}
