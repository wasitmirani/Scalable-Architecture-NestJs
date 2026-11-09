import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { USER_ONLY_KEY } from '../decorators/roles.decorator';
import {
  ForbiddenException,
  UnauthorizedException,
} from '../exceptions/custom.exceptions';
import type { Principal } from '../types/principal';
import { ApiKeysService } from '../../modules/api-keys/api-keys.service';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

/**
 * Global authentication: every route requires a valid access token
 * (`Authorization: Bearer`) or API key (`X-Api-Key`) unless marked @Public().
 * Access tokens are checked against their session so logout and password
 * resets take effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly dataSource: DataSource,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets))
      return true;

    const req = context.switchToHttp().getRequest<Request>();
    const apiKey = req.headers['x-api-key'];
    req.principal =
      typeof apiKey === 'string' && apiKey.length > 0
        ? await this.apiKeys.authenticate(apiKey)
        : await this.authenticateBearer(req);

    if (
      req.principal.type === 'api_key' &&
      this.reflector.getAllAndOverride<boolean>(USER_ONLY_KEY, targets)
    ) {
      throw new ForbiddenException(
        'This endpoint requires a user session',
        'USER_ONLY',
      );
    }
    return true;
  }

  private async authenticateBearer(req: Request): Promise<Principal> {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException(
        'Missing bearer token',
        'UNAUTHENTICATED',
      );
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired access token',
        'INVALID_TOKEN',
      );
    }
    if (payload.typ !== 'access') {
      throw new UnauthorizedException(
        'Invalid or expired access token',
        'INVALID_TOKEN',
      );
    }

    const [row] = await this.dataSource.query<
      Array<{ email: string; status: string; is_platform_admin: boolean }>
    >(
      `SELECT u.email, u.status, u.is_platform_admin
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND u.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [payload.sid, payload.sub],
    );
    if (!row)
      throw new UnauthorizedException('Session has ended', 'SESSION_ENDED');
    if (row.status !== 'active') {
      throw new UnauthorizedException(
        'Account is disabled',
        'ACCOUNT_DISABLED',
      );
    }

    return {
      type: 'user',
      userId: payload.sub,
      sessionId: payload.sid,
      email: row.email,
      isPlatformAdmin: row.is_platform_admin,
    };
  }
}
