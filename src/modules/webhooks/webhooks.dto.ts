import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { WEBHOOK_EVENT_IDS } from './webhooks.constants';

export class CreateWebhookDto {
  /** يُفحص في الخدمة (https، لا عناوين داخلية) — الشكل وحده لا يكفي. */
  @IsString()
  @MaxLength(500)
  url!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'اختر حدثًا واحدًا على الأقل' })
  @ArrayMaxSize(20)
  @IsIn(WEBHOOK_EVENT_IDS, { each: true, message: 'حدث غير معروف' })
  events!: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'اختر حدثًا واحدًا على الأقل' })
  @ArrayMaxSize(20)
  @IsIn(WEBHOOK_EVENT_IDS, { each: true, message: 'حدث غير معروف' })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
