import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { AI_LIMITS } from './ai.config';

export class AiChatDto {
  /** فارغ = محادثة جديدة */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** فارغ مع `regenerate` — يُعاد توليد آخر رد */
  @IsOptional()
  @IsString()
  @MaxLength(AI_LIMITS.messageChars)
  message?: string;

  /** للمحادثة الجديدة فقط: chat عام، insights بأرقام المتجر */
  @IsOptional()
  @IsIn(['chat', 'insights'])
  mode?: 'chat' | 'insights';

  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}

export class AiRenameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(AI_LIMITS.titleChars)
  title!: string;
}

const LANG = ['ar', 'en'] as const;

export class AiProductInput {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  /** المواصفات والمزايا والملاحظات كما يعرفها التاجر */
  @IsOptional() @IsString() @MaxLength(2500) details?: string;
  @IsOptional() @IsString() @MaxLength(200) audience?: string;
  @IsOptional() @IsString() @MaxLength(60) tone?: string;
}

export class AiMarketingInput {
  @IsString() @MinLength(2) @MaxLength(1500) topic!: string;
  @IsIn(['instagram', 'tiktok', 'snapchat', 'whatsapp', 'facebook', 'x', 'ad', 'sms'])
  platform!: string;
  @IsOptional() @IsString() @MaxLength(60) tone?: string;
  @IsOptional() @IsString() @MaxLength(120) goal?: string;
  @IsOptional() @IsString() @MaxLength(120) occasion?: string;
  @IsOptional() @IsString() @MaxLength(120) offer?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) count?: number;
}

export class AiSeoInput {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(300) keywords?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
}

export class AiReplyInput {
  /** رسالة العميل أو نص تقييمه كما وصل */
  @IsString() @MinLength(2) @MaxLength(2000) message!: string;
  @IsOptional() @IsIn(['message', 'review']) kind?: 'message' | 'review';
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  /** ما يعرفه التاجر عن الموقف وما يستطيع تقديمه */
  @IsOptional() @IsString() @MaxLength(1000) context?: string;
}

export class AiPolicyInput {
  @IsIn(['exchange', 'shipping', 'privacy', 'about', 'faq', 'terms']) kind!: string;
  @IsOptional() @IsString() @MaxLength(2000) details?: string;
}

export class AiGenerateDto {
  @IsIn(['product', 'marketing', 'seo', 'reply', 'policy'])
  tool!: 'product' | 'marketing' | 'seo' | 'reply' | 'policy';

  @IsIn(LANG)
  language!: 'ar' | 'en';

  @IsOptional() @ValidateNested() @Type(() => AiProductInput) product?: AiProductInput;
  @IsOptional() @ValidateNested() @Type(() => AiMarketingInput) marketing?: AiMarketingInput;
  @IsOptional() @ValidateNested() @Type(() => AiSeoInput) seo?: AiSeoInput;
  @IsOptional() @ValidateNested() @Type(() => AiReplyInput) reply?: AiReplyInput;
  @IsOptional() @ValidateNested() @Type(() => AiPolicyInput) policy?: AiPolicyInput;
}
