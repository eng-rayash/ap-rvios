import { IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MinLength } from 'class-validator';

export class EmailDto {
  @IsEmail({}, { message: 'بريد إلكتروني غير صالح' })
  email!: string;
}

export class VerifyCodeDto extends EmailDto {
  @IsString()
  @Length(6, 6, { message: 'الرمز ستة أرقام' })
  @Matches(/^\d{6}$/, { message: 'الرمز ستة أرقام' })
  code!: string;

  /** الشركة المطلوبة لمن ينتمي لأكثر من واحدة — يُتحقق من عضويته كما في الدخول */
  @IsOptional()
  @IsUUID()
  companyId?: string;
}

export class ResetPasswordDto extends VerifyCodeDto {
  @IsString()
  @MinLength(8, { message: 'كلمة المرور ثماني خانات على الأقل' })
  newPassword!: string;
}
