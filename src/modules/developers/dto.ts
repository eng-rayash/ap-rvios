import { IsInt, IsString, Length, Max, Min } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @Length(2, 60, { message: 'الاسم بين حرفين و٦٠' })
  name!: string;

  /** الدور الذي سيعمل به المفتاح — 0=مالك … 9=ضيف. لا يجوز أعلى من دور مُصدِره. */
  @IsInt()
  @Min(0)
  @Max(9)
  role!: number;
}
