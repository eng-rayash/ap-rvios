import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';

/** تقييم من مشترٍ — لسطر من طلبه المكتمل */
export class SubmitReviewDto {
  /** سطر الطلب المُقيَّم (`items[].id` في التتبّع) */
  @IsUUID()
  itemId!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsString()
  @Length(2, 1000, { message: 'اكتب رأيك في سطرين على الأقل' })
  body!: string;

  /** الاسم الظاهر — افتراضيًا اسم الطلب */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;
}

/** قرار التاجر في تقييم: نشر أو إخفاء، وردّ يظهر تحته */
export class UpdateReviewDto {
  /** 0=قيد المراجعة · 1=منشور · 2=مخفي */
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  status?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reply?: string;
}
