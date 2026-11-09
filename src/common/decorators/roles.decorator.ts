import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';
export const TENANT_SCOPED_KEY = 'tenantScoped';
export const USER_ONLY_KEY = 'userOnly';

/**
 * Requires a tenant context (from `:tenantId` or the `X-Tenant-Id` header, or the
 * API key's tenant) and every listed permission within that tenant.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Requires a verified tenant context without a specific permission. */
export const TenantScoped = () => SetMetadata(TENANT_SCOPED_KEY, true);

/** Rejects API-key principals (e.g. account and session management). */
export const UserOnly = () => SetMetadata(USER_ONLY_KEY, true);
