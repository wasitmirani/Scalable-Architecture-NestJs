/** Who is calling: a signed-in user or a tenant API key. */
export type Principal =
  | {
      type: 'user';
      userId: string;
      sessionId: string;
      email: string;
      isPlatformAdmin: boolean;
    }
  | {
      type: 'api_key';
      apiKeyId: string;
      tenantId: string;
      scopes: string[];
    };

/** The tenant a request operates on, resolved and verified server-side. */
export interface TenantContext {
  tenantId: string;
  /** Present for user principals. */
  memberId: string | null;
  roleKey: string | null;
  permissions: ReadonlySet<string>;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
    principal?: Principal;
    tenant?: TenantContext;
  }
}
