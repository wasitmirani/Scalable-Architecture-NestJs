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
  constructor(message: string = 'Bad request', code: string = 'BAD_REQUEST') {
    // Do not include stack trace in response
    super(
      {
        message,
        error: 'Bad Request',
        code,
      },
      HttpStatus.BAD_REQUEST,
    );
    // Remove stack from the response to avoid leaking it
    this.stack = undefined;
  }
}

export class UnauthorizedException extends HttpException {
  constructor(
    message: string = 'Unauthorized access',
    code: string = 'UNAUTHORIZED',
  ) {
    super(
      {
        message,
        error: 'Unauthorized',
        code,
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class ForbiddenException extends HttpException {
  constructor(
    message: string = 'Access forbidden',
    code: string = 'FORBIDDEN',
  ) {
    super(
      {
        message,
        error: 'Forbidden',
        code,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class NotFoundException extends HttpException {
  constructor(resource: string = 'Resource', code: string = 'NOT_FOUND') {
    super(
      {
        message: `${resource} not found`,
        error: 'Not Found',
        code,
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ConflictException extends HttpException {
  constructor(
    message: string = 'Resource conflict',
    code: string = 'CONFLICT',
  ) {
    super(
      {
        message,
        error: 'Conflict',
        code,
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
