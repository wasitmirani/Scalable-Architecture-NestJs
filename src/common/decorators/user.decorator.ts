import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal, RequestMeta, TenantContext } from '../types/principal';

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<Request>().principal;
    if (!principal) throw new Error('CurrentPrincipal used on a public route');
    return principal;
  },
);

/** The authenticated user principal; use only on @UserOnly() routes. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Extract<Principal, { type: 'user' }> => {
    const principal = ctx.switchToHttp().getRequest<Request>().principal;
    if (principal?.type !== 'user')
      throw new Error('CurrentUser used without @UserOnly()');
    return principal;
  },
);

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext => {
    const tenant = ctx.switchToHttp().getRequest<Request>().tenant;
    if (!tenant)
      throw new Error(
        'CurrentTenant used without @RequirePermissions/@TenantScoped',
      );
    return tenant;
  },
);

export const ReqMeta = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestMeta =>
    requestMeta(ctx.switchToHttp().getRequest()),
);

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 500) : null,
    requestId: req.id ?? null,
  };
}
