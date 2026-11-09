import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a caller-supplied X-Request-Id (if well-formed) or generates one, and echoes it back. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers['x-request-id'];
    req.id =
      typeof incoming === 'string' && SAFE_ID.test(incoming)
        ? incoming
        : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  }
}
