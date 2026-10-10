import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

import { TenantIsolationError } from '../prisma/tenant-prisma.service';
import { VersionConflictError } from '../../modules/meetings/meetings.service';

/**
 * AZM — ترجمة أخطاء المجال إلى ردود HTTP
 *
 * خطأان يستحقّان ترجمة خاصة:
 *
 * **[TenantIsolationError] → ٤٠٤ لا ٤٠٣.** «ممنوع» يؤكّد أن السجلّ
 * موجود لدى شركة أخرى، و«غير موجود» لا يقول شيئًا. الفارق بينهما
 * يسمح بعدّ سجلّات الآخرين بالتجربة. الحدث يُسجَّل عندنا بمستواه
 * الحقيقي — نخفيه عن الطالب لا عن أنفسنا.
 *
 * **[VersionConflictError] → ٤٠٩.** المزامنة تحتاج أن تفرّق بين
 * «فشل» و«تجاوزك غيرك»، لأن الثاني يُعالَج بإعادة الجلب والدمج لا
 * بإعادة المحاولة.
 *
 * ما عدا ذلك يمرّ كما هو: ابتلاع خطأ غير متوقَّع يحوّله إلى ٥٠٠ بلا
 * أثر، وهو أسوأ من ظهوره.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof TenantIsolationError) {
      this.logger.warn(`عزل مستأجر: ${exception.message}`);
      res.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'السجلّ غير موجود',
      });
      return;
    }

    if (exception instanceof VersionConflictError) {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        message: exception.message,
        currentVersion: exception.currentVersion,
        expectedVersion: exception.expectedVersion,
      });
      return;
    }

    if (exception instanceof HttpException) {
      // `new HttpException('نص', …)` يعيد نصًّا خامًا — نلفّه بالشكل الموحّد
      // `{ statusCode, message }` الذي تقرؤه الواجهات، وإلا ضاعت الرسالة
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(
        typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body,
      );
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'خطأ داخلي',
    });
  }
}
