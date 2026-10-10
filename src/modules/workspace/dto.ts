import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, MinLength } from 'class-validator';

export class AddMemberDto {
  @IsEmail({}, { message: 'بريد إلكتروني غير صالح' })
  email!: string;

  @IsString()
  @Length(2, 80, { message: 'الاسم بين حرفين و٨٠' })
  displayName!: string;

  /** مطلوبة فقط إن لم يكن للبريد حساب قائم — الحساب القائم يحتفظ بكلمة مروره. */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'كلمة المرور ثماني خانات على الأقل' })
  password?: string;

  /** 1..9 — المالك (0) واحد لكل شركة ولا يُمنح من هنا. */
  @IsInt()
  @Min(1)
  @Max(9)
  role!: number;
}

export class UpdateMemberDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  role?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 80, { message: 'الاسم بين حرفين و٨٠' })
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  /** رابط صورة (http/https) — الرفع الفعلي للملفات لاحقًا. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'كلمة المرور ثماني خانات على الأقل' })
  @MaxLength(200)
  newPassword!: string;
}
