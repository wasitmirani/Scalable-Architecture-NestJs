// Import required NestJS decorators and interfaces
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Express request lifecycle types
import { Request, Response, NextFunction } from 'express';

// JWT library for token verification
import * as jwt from 'jsonwebtoken';

@Injectable() // Marks class as injectable so Nest can manage it
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly configService: ConfigService) {}

  /**
   * This method runs before the route handler.
   * It checks for a valid JWT token in the Authorization header.
   */
  use(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Authorization header missing');
    }

    // Accept "Bearer <token>" or a raw JWT (no scheme)
    const parts = authHeader.trim().split(/\s+/);
    const token =
      parts.length === 1
        ? parts[0]
        : parts[0].toLowerCase() === 'bearer'
          ? parts.slice(1).join(' ')
          : null;

    if (!token) {
      throw new UnauthorizedException('Token missing');
    }

    const secret =
      this.configService.get<string>('JWT_SECRET') || 'defaultSecret';

    try {
      const decoded = jwt.verify(token, secret);
      req['user'] = decoded;
      next();
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
