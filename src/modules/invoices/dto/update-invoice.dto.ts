import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsNumber, IsOptional, Min } from 'class-validator';

import { CreateInvoiceDto } from './create-invoice.dto';

/**
 * تعديل فاتورة — كل حقول الإنشاء اختيارية عدا `syncId` المحذوف، مع
 * إضافة `paidAmount`.
 *
 * `paidAmount` لا يظهر في الإنشاء: فاتورة جديدة غير مدفوعة بالتعريف،
 * والدفع حدث لاحق يُسجَّل بتعديل. `remainingAmount` يُشتقّ منه ومن
 * `total` في الخدمة — لا يُقبل مباشرة للسبب نفسه الذي يمنع قبول
 * `total`.
 */
export class UpdateInvoiceDto extends PartialType(
  OmitType(CreateInvoiceDto, ['syncId'] as const),
) {
  @IsOptional()
  @IsNumber()
  @Min(0)
  paidAmount?: number;
}
