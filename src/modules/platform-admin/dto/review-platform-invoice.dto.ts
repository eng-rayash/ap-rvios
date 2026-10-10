import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/** مراجعة فاتورة اشتراك — تسجيل الدفع أو رفضه بعد التحقّق اليدوي. */
export class ReviewPlatformInvoiceDto {
  @IsIn(['paid', 'rejected'])
  decision!: 'paid' | 'rejected';

  @IsOptional()
  @IsString()
  @Length(0, 200)
  paymentReference?: string;

  /** سبب الرفض — يُخزَّن في `voidReason` */
  @IsOptional()
  @IsString()
  @Length(0, 200)
  reason?: string;
}
