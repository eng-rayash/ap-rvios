import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { InvoiceItemDto } from './invoice-item.dto';

/**
 * إنشاء فاتورة.
 *
 * لاحظ ما **ليس** هنا: لا `invoiceNumber` ولا `subtotal`/`taxAmount`/
 * `total`/`remainingAmount`. هذه كلها تُشتقّ في الخدمة من `items`
 * و`discountAmount` و`taxPercent` — قيَم محسوبة لا تُترك لثقة العميل
 * في حسابها الصحيح، بنفس منطق غياب `nameNormalized` من عميل.
 */
export class CreateInvoiceDto {
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  /** `YYYY-MM-DD` — نصّ لا تاريخ، مطابقةً لبقية النظام. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'الصيغة YYYY-MM-DD' })
  issueDate!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'الصيغة YYYY-MM-DD' })
  dueDate?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'الفاتورة تحتاج بندًا واحدًا على الأقلّ' })
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxPercent?: number;

  @IsOptional()
  @IsIn(['SAR', 'YER', 'USD'])
  currency?: string;

  // 0=مسوَّدة · 1=مُرسَلة · 2=مدفوعة جزئيًا · 3=مدفوعة · 4=متأخّرة · 5=ملغاة
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  status?: number;
}
