import { HttpException, HttpStatus } from '@nestjs/common';

export class BusinessException extends HttpException {
  constructor(message: string, code: string = 'BUSINESS_ERROR') {
    super({ message, code }, HttpStatus.BAD_REQUEST);
  }
}

export class ValidationException extends HttpException {
  constructor(errors: any[]) {
    super(
      {
        message: 'Validation failed',
        error: 'ValidationError',
        details: errors,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class BadRequestException extends HttpException {
  constructor(message: string = 'Bad request') {
    // Do not include stack trace in response
    super(
      {
        message,
        error: 'Bad Request',
        code: 'BAD_REQUEST',
      },
      HttpStatus.BAD_REQUEST,
    );
    // Remove stack from the response to avoid leaking it
    (this as any).stack = undefined;
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message: string = 'Unauthorized access') {
    super(
      {
        message,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class ForbiddenException extends HttpException {
  constructor(message: string = 'Access forbidden') {
    super(
      {
        message,
        error: 'Forbidden',
        code: 'FORBIDDEN',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class NotFoundException extends HttpException {
  constructor(resource: string = 'Resource') {
    super(
      {
        message: `${resource} not found`,
        error: 'Not Found',
        code: 'NOT_FOUND',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ConflictException extends HttpException {
  constructor(message: string = 'Resource conflict') {
    super(
      {
        message,
        error: 'Conflict',
        code: 'CONFLICT',
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class RateLimitException extends HttpException {
  constructor(message: string = 'Too many requests') {
    super(
      {
        message,
        error: 'Rate Limit Exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message: string = 'Service temporarily unavailable') {
    super(
      {
        message,
        error: 'Service Unavailable',
        code: 'SERVICE_UNAVAILABLE',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}