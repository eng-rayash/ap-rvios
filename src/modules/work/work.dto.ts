import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateProjectDto {
  /** رمز لاتيني قصير: APP, WEB … */
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9]{1,7}$/, { message: 'الرمز حروف وأرقام لاتينية (٢–٨) يبدأ بحرف' })
  key!: string;

  @IsString()
  @Length(2, 80)
  name!: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsInt() @Min(0) @Max(3)
  status?: number;

  @IsOptional() @IsString() @MaxLength(40)
  color?: string;

  @IsOptional() @IsString() @MaxLength(40)
  category?: string;

  @IsOptional() @IsUUID()
  leadId?: string;

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsInt() @Min(0)
  budget?: number;

  @IsOptional() @IsInt() @Min(0)
  spent?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  memberIds?: string[];
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @Length(2, 80)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsInt() @Min(0) @Max(3)
  status?: number;

  @IsOptional() @IsString() @MaxLength(40)
  color?: string;

  @IsOptional() @IsString() @MaxLength(40)
  category?: string;

  @IsOptional() @IsUUID()
  leadId?: string;

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsInt() @Min(0)
  budget?: number;

  @IsOptional() @IsInt() @Min(0)
  spent?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  memberIds?: string[];
}

export class MilestoneDto {
  @IsString() @Length(2, 80)
  title!: string;

  @IsDateString()
  date!: string;

  @IsOptional() @IsBoolean()
  done?: boolean;
}

export class UpdateMilestoneDto {
  @IsOptional() @IsString() @Length(2, 80)
  title?: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsBoolean()
  done?: boolean;
}

export class CreateTaskDto {
  @IsUUID()
  projectId!: string;

  @IsString() @Length(2, 160)
  title!: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  status?: number;

  @IsOptional() @IsInt() @Min(0) @Max(3)
  priority?: number;

  @IsOptional() @IsUUID()
  assigneeId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(24, { each: true })
  labels?: string[];

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  points?: number;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @Length(2, 160)
  title?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  status?: number;

  @IsOptional() @IsInt() @Min(0) @Max(3)
  priority?: number;

  /** null = إلغاء الإسناد */
  @IsOptional() @IsUUID()
  assigneeId?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(24, { each: true })
  labels?: string[];

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  points?: number;

  @IsOptional() @IsInt() @Min(0)
  position?: number;
}

export class CommentDto {
  @IsString() @Length(1, 2000)
  body!: string;
}
