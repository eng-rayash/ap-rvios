import {
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';

export class CreatePlatformInvoiceDto {
  @IsUUID()
  companyId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsIn(['SAR', 'YER', 'USD'])
  currency?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'الصيغة YYYY-MM-DD' })
  periodStart!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'الصيغة YYYY-MM-DD' })
  periodEnd!: string;
}
