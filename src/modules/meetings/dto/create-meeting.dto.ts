import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * إنشاء اجتماع.
 *
 * `companyId` و`createdBy` و`version` غائبة عمدًا، وغيابها مُنفَّذ لا
 * موصوف: `forbidNonWhitelisted` في `main.ts` يرفض الطلب الذي يحملها
 * بدل أن يتجاهلها بصمت.
 */
export class CreateMeetingDto {
  /**
   * معرّف الصفّ حين يكون أُنشئ على الجهاز أولًا.
   *
   * قبوله من العميل مقصود ولا يكسر العزل: العمود فريد عالميًا، فأسوأ
   * ما يفعله معرّف مُخمَّن هو تصادم يفشل عليه الإدراج. والمزامنة
   * تحتاجه: بدونه يصير للصفّ هويتان، واحدة محليًا وأخرى على الخادم.
   */
  @IsOptional()
  @IsUUID()
  syncId?: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  /** `YYYY-MM-DD` — نصّ لا تاريخ، مطابقةً لتخزين العميل. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'الصيغة YYYY-MM-DD' })
  date!: string;

  /** `HH:MM` بنظام ٢٤ ساعة. */
  @Matches(/^\d{2}:\d{2}$/, { message: 'الصيغة HH:MM' })
  time!: string;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'الصيغة HH:MM' })
  endTime?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  location?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  objective?: string;

  // التعدادات أرقام لا نصوص — العقد نفسه في `enums.dart` على العميل.
  // الحدّان يمنعان قيمة خارج المدى تجعل الواجهة تعرض حالة لا تعرفها.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  meetingType?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  meetingCategory?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  priority?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  status?: number;

  @IsOptional()
  @IsObject()
  agenda?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  attendees?: Record<string, unknown>;
}
