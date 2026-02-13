// Import required NestJS decorators and interfaces
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';

// Express request lifecycle types
import { Request, Response, NextFunction } from 'express';

// JWT library for token verification
import * as jwt from 'jsonwebtoken';

@Injectable() // Marks class as injectable so Nest can manage it
export class AuthMiddleware implements NestMiddleware {

  /**
   * This method runs before the route handler.
   * It checks for a valid JWT token in the Authorization header.
   */
  use(req: Request, res: Response, next: NextFunction) {

    // 1️⃣ Get Authorization header
    const authHeader = req.headers.authorization;

    // 2️⃣ If no header found → throw Unauthorized error
    if (!authHeader) {
      throw new UnauthorizedException('Authorization header missing');
    }

    // 3️⃣ Extract token from "Bearer <token>"
    const token = authHeader.split(' ')[1];

    // 4️⃣ If token missing after split → reject request
    if (!token) {
      throw new UnauthorizedException('Token missing');
    }

    try {
      // 5️⃣ Verify token using secret key
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string);

      // 6️⃣ Attach decoded user data to request object
      // This makes user available in controllers via req.user
      req['user'] = decoded;

      // 7️⃣ Continue to next middleware or route handler
      next();

    } catch (error) {
      // 8️⃣ If token invalid or expired → reject request
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
