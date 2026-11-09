import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { STATUS_CODES } from 'http';
import { QueryFailedError } from 'typeorm';

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Standard error envelope:
 * { success: false, statusCode, code, message, error, details?, requestId, timestamp, path, method }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string | object;
    let error: string;
    let code: string | undefined;
    let validationErrors: unknown[] = [];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = STATUS_CODES[status] ?? exception.name;
      } else {
        const responseObj = exceptionResponse as {
          message?: string | string[];
          error?: string;
          code?: string;
          details?: unknown;
        };
        message = responseObj.message || exception.message;
        error = responseObj.error || exception.name;
        code = responseObj.code;

        if (Array.isArray(responseObj.details)) {
          validationErrors = responseObj.details;
          code ??= 'VALIDATION_ERROR';
        } else if (Array.isArray(responseObj.message)) {
          validationErrors = responseObj.message;
          message = 'Validation failed';
          code ??= 'VALIDATION_ERROR';
        }
      }
    } else if (
      exception instanceof QueryFailedError &&
      (exception.driverError as { code?: string } | undefined)?.code === '23505'
    ) {
      // Unique violation that slipped past an explicit check (e.g. a concurrent request).
      status = HttpStatus.CONFLICT;
      message = 'Resource already exists';
      error = 'Conflict';
    } else {
      // Never expose internal error messages (SQL, stack details) to clients.
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      error = 'InternalServerError';
    }
    code ??= DEFAULT_CODES[status] ?? 'ERROR';

    const logLine = `HTTP ${status} ${code} - ${request.method} ${request.url} - ${JSON.stringify(message)} [${request.id ?? '-'}]`;
    if (status >= 500) {
      this.logger.error(
        logLine,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(logLine);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      code,
      message,
      error,
      ...(validationErrors.length > 0 && { details: validationErrors }),
      requestId: request.id ?? null,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      ...(process.env.NODE_ENV === 'development' &&
        status >= 500 && {
          stack: exception instanceof Error ? exception.stack : undefined,
        }),
    });
  }
}
