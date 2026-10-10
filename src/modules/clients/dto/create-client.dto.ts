import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

/**
 * إنشاء عميل.
 *
 * `nameNormalized` غائب عمدًا: يُشتقّ من `name` في الخدمة لا يُقبل من
 * العميل — نفس سبب غياب `companyId`، قيمة مشتقّة لا تُترك لثقة الطرف
 * الآخر في حسابها بشكل صحيح.
 */
export class CreateClientDto {
  /** معرّف الصفّ حين يكون أُنشئ على الجهاز أولًا — انظر توثيقه في اجتماعات. */
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 30)
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'بريد إلكتروني غير صالح' })
  email?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  address?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(0, 50)
  taxNumber?: string;
}
