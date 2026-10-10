import { IsNumber, IsPositive, IsString, Length, Min } from 'class-validator';

/**
 * بند فاتورة.
 *
 * لا `lineTotal` هنا: يُحسب في الخدمة من `quantity × unitPrice` —
 * قبوله من العميل يفتح البند نفسه على تناقض بين ما أُرسل وما يُحسب.
 */
export class InvoiceItemDto {
  @IsString()
  @Length(1, 200)
  description!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;
}

/** شكل البند كما تستهلكه الخدمة — مطابق لـ`InvoiceItemDto` بلا زخرفة التحقّق. */
export interface InvoiceItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
}
