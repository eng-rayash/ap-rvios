import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length } from 'class-validator';

/** ما يُرسله زائر الموقع من نموذج التواصل العام — لا مصادقة. */
export class SubmitContactDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /** البريد أو الهاتف — أحدهما يكفي، والخدمة ترفض الطلب بلا أيّهما. */
  @IsOptional()
  @IsEmail({}, { message: 'بريد إلكتروني غير صالح' })
  email?: string;

  @IsOptional()
  @IsString()
  @Length(0, 30)
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(0, 160)
  service?: string;

  @IsString()
  @Length(1, 4000)
  message!: string;
}

/** تحديث حالة رسالة تواصل — فريق الموقع فقط. */
export class UpdateContactStatusDto {
  // 0=غير مقروءة · 1=مقروءة · 2=تم الرد
  @IsInt()
  @IsIn([0, 1, 2])
  status!: number;
}
