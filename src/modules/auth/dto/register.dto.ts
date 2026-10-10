import { IsEmail, IsString, Length, MinLength } from 'class-validator';

/**
 * تسجيل حساب وشركة معًا.
 *
 * لاحظ ما **ليس** هنا: لا `role` ولا `companyId`. المُسجِّل يصير
 * مالكًا لشركته الجديدة بقرار الخادم، ولو قَبِلنا الدور من العميل
 * لصار بإمكان أي أحد أن يعلن نفسه مالكًا لشركة قائمة.
 */
export class RegisterDto {
  @IsEmail({}, { message: 'بريد إلكتروني غير صالح' })
  email!: string;

  /**
   * الحدّ الأدنى ثماني خانات.
   *
   * لا نفرض تشكيلة رموز: قواعد التعقيد تدفع إلى `P@ssw0rd!` وأمثالها،
   * والطول وحده أقوى أثرًا. التجزئة بـbcrypt بـ١٢ جولة.
   */
  @IsString()
  @MinLength(8, { message: 'كلمة المرور ثماني خانات على الأقل' })
  password!: string;

  @IsString()
  @Length(2, 80, { message: 'الاسم بين حرفين و٨٠' })
  displayName!: string;

  @IsString()
  @Length(2, 120, { message: 'اسم الشركة بين حرفين و١٢٠' })
  companyName!: string;
}
