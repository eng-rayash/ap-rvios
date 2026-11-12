import { IsEmail, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'بريد إلكتروني غير صالح' })
  email!: string;

  @IsString()
  password!: string;

  /**
   * الشركة المطلوبة حين ينتمي المستخدم لأكثر من واحدة.
   *
   * ليست ثغرة رغم أنها تأتي من العميل: `login` يتحقّق من وجود عضوية
   * فعّالة فيها قبل إصدار الرمز، فأقصى ما يفعله المهاجم أن يطلب شركة
   * لا ينتمي إليها فيُرفض.
   */
  @IsOptional()
  @IsUUID()
  companyId?: string;

  /**
   * «جهاز موثوق»: رمز يصدره الخادم بعد تأكيد رمز البريد. يُعفي من رمز البريد
   * في الدخول التالي على الجهاز نفسه لمدة محددة — كلمة المرور تبقى مطلوبة.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  trustToken?: string;
}
