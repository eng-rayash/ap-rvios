import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

/**
 * تسجيل وسيط — تخزين الملف نفسه (رفعه إلى R2/S3) خارج نطاق هذه الوحدة
 * عمدًا؛ هذا يسجّل بيانات وصفية عن ملف مرفوع مسبقًا لا يستقبل الملف.
 */
export class CreateMediaDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  url!: string;

  @IsString()
  filename!: string;

  @IsString()
  originalName!: string;

  @IsString()
  mimeType!: string;

  @IsInt()
  @Min(0)
  size!: number;

  // 0=صورة · 1=فيديو · 2=مستند
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  type?: number;
}
