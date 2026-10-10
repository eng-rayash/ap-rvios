import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateMeetingDto } from './create-meeting.dto';

/**
 * تعديل اجتماع — كل الحقول اختيارية عدا `syncId` المحذوف.
 *
 * `syncId` لا يُعدَّل: هو الهوية التي تقع عليها المطابقة بين الجهاز
 * والخادم، وتغييره يقطع الصلة فيظهر الصفّ سجلًّا جديدًا عند المزامنة
 * التالية.
 */
export class UpdateMeetingDto extends PartialType(
  OmitType(CreateMeetingDto, ['syncId'] as const),
) {}
