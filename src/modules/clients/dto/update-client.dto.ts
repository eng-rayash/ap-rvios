import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateClientDto } from './create-client.dto';

/**
 * تعديل عميل — كل الحقول اختيارية عدا `syncId` المحذوف.
 *
 * انظر تسويغ حذف `syncId` من التعديل في `update-meeting.dto.ts`: هو
 * الهوية التي تقع عليها مطابقة المزامنة، وتغييره يقطعها.
 */
export class UpdateClientDto extends PartialType(
  OmitType(CreateClientDto, ['syncId'] as const),
) {}
