import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class AiPublicTurn {
  @IsIn(['user', 'model'])
  role!: 'user' | 'model';

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

export class AiPublicChatDto {
  /** web = www.rvios.com · platform = store.rvios.com */
  @IsIn(['web', 'platform'])
  site!: 'web' | 'platform';

  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  /** الصفحة التي يقرؤها الزائر — يفهم منها المساعد سياق سؤاله */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  page?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AiPublicTurn)
  turns!: AiPublicTurn[];
}
