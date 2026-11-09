import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  PERMISSIONS_KEY,
  TENANT_SCOPED_KEY,
} from '../decorators/roles.decorator';
import { ForbiddenException } from '../exceptions/custom.exceptions';
import { AccessService } from '../../modules/access/access.service';

/**
 * Resolves and verifies the tenant context for routes marked with
 * @RequirePermissions or @TenantScoped, then checks permissions.
 * Runs after AuthGuard.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      targets,
    );
    const scoped = this.reflector.getAllAndOverride<boolean>(
      TENANT_SCOPED_KEY,
      targets,
    );
    if (!required && !scoped) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (!req.principal)
      throw new Error('Tenant-scoped route must not be @Public()');

    const header = req.headers['x-tenant-id'];
    const requested =
      req.params.tenantId ?? (typeof header === 'string' ? header : undefined);
    const tenant = await this.access.resolveTenantContext(
      req.principal,
      requested,
    );

    const missing = (required ?? []).filter((p) => !tenant.permissions.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission: ${missing.join(', ')}`,
        'MISSING_PERMISSION',
      );
    }

    req.tenant = tenant;
    return true;
  }
}
