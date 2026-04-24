import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : (body as any).message || exception.message;
      code = 'HTTP_EXCEPTION';
    } else if (exception instanceof QueryFailedError) {
      if (exception.message.includes('UNIQUE constraint failed')) {
        status = HttpStatus.CONFLICT;
        message =
          'Duplicate request_id: this request has already been submitted. Retrieve the original result by request_id.';
        code = 'DUPLICATE_REQUEST_ID';
      } else {
        message = 'Database operation failed';
        code = 'DATABASE_ERROR';
      }
    } else if (exception instanceof Error) {
      if (
        exception.constructor.name === 'OptimisticLockVersionMismatchError' ||
        exception.message?.includes('optimistic lock')
      ) {
        status = HttpStatus.CONFLICT;
        message =
          'Concurrent modification detected. A parallel request updated the same record. Please retry.';
        code = 'OPTIMISTIC_LOCK_CONFLICT';
      }
    }

    this.logger.error(
      `[${request.method}] ${request.url} → ${status} ${code}: ${message}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(status).json({
      statusCode: status,
      code,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
