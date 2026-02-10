import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl, headers } = req;
    
    // Log incoming request
    this.logger.log(`Incoming Request: ${method} ${originalUrl}`);
    
    // Log authorization header (masked for security)
    if (headers.authorization) {
      const authHeader = headers.authorization;
      const maskedHeader = authHeader.length > 10 
        ? `${authHeader.substring(0, 10)}...` 
        : '***';
      this.logger.debug(`Authorization Header: ${maskedHeader}`);
    }

    res.on('finish', () => {
      const { statusCode } = res;
      this.logger.log(`Response: ${method} ${originalUrl} - ${statusCode}`);
    });

    next();
  }
}