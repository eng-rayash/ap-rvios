import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class AskQuestionDto {
  @IsString() @Length(5, 500) question!: string;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
}

export class AnswerQuestionDto {
  @IsOptional() @IsString() @MaxLength(1000) answer?: string;
  /** 0 بانتظار · 1 منشور · 2 مخفي */
  @IsOptional() @IsInt() @IsIn([0, 1, 2]) status?: number;
}
