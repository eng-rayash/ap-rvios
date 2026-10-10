import { IsIn, IsInt, IsOptional, IsString, Length } from 'class-validator';

export class UpsertSettingDto {
  @IsString()
  @Length(1, 120)
  key!: string;

  @IsString()
  value!: string;

  // 0=نص · 1=JSON · 2=منطقي · 3=رقم
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2, 3])
  type?: number;

  @IsOptional()
  @IsString()
  @Length(0, 160)
  label?: string;
}
