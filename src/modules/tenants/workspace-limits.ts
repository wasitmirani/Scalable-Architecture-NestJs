import { ForbiddenException } from '../../common/exceptions/custom.exceptions';
import { OWNER_ROLE_KEY } from '../access/entities/role.entity';

/** Anything that runs SQL: a DataSource or an EntityManager on the owner connection. */
interface Queryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

/**
 * How many workspaces one person may own. Every workspace starts on Free with its
 * own allowance, so without a limit a user could multiply the free plan.
 * - MAX_FREE_WORKSPACES_PER_USER (default 1): owned workspaces on the Free plan.
 * - MAX_WORKSPACES_PER_USER (default 10): owned workspaces in total.
 * Joining someone else's workspace never counts. Platform admins are exempt.
 */
export function workspaceLimits() {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    free: n(process.env.MAX_FREE_WORKSPACES_PER_USER, 1),
    total: n(process.env.MAX_WORKSPACES_PER_USER, 10),
  };
}

export interface OwnedWorkspace {
  id: string;
  name: string;
  /** Effective plan: a cancelled or unpaid subscription counts as Free. */
  plan: string;
}

/**
 * Active workspaces a user owns, with their effective plan. Must run on the owner
 * connection (not inside a tenant transaction), because it reads across workspaces.
 */
export async function ownedWorkspaces(q: Queryable, userId: string, excludeTenantId?: string): Promise<OwnedWorkspace[]> {
  const rows = await q.query<{ id: string; name: string; plan: string | null; status: string | null }[]>(
    `SELECT t.id, t.name, s.data->>'planId' AS plan, s.data->>'status' AS status
       FROM tenant_members m
       JOIN roles r ON r.id = m.role_id AND r.key = $2 AND r.tenant_id IS NULL
       JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
       LEFT JOIN product_records s ON s.tenant_id = t.id AND s.collection = 'billing/subscription'
      WHERE m.user_id = $1 AND m.status = 'active' AND ($3::uuid IS NULL OR t.id <> $3::uuid)`,
    [userId, OWNER_ROLE_KEY, excludeTenantId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    plan: !r.plan || (r.status && !['active', 'trialing'].includes(r.status)) ? 'free' : r.plan,
  }));
}

/** Before creating a workspace (it starts on Free). Throws 403 WORKSPACE_LIMIT. */
export async function assertCanCreateWorkspace(q: Queryable, userId: string) {
  const [user] = await q.query<{ is_platform_admin: boolean }[]>(`SELECT is_platform_admin FROM users WHERE id = $1`, [userId]);
  if (user?.is_platform_admin) return;
  const limits = workspaceLimits();
  const owned = await ownedWorkspaces(q, userId);
  if (owned.length >= limits.total) {
    throw new ForbiddenException(
      `You already own ${owned.length} workspaces, the most one person can own. Delete one you no longer use, or contact support.`,
      'WORKSPACE_LIMIT',
    );
  }
  const free = owned.filter((w) => w.plan === 'free');
  if (free.length >= limits.free) {
    const names = free.map((w) => `“${w.name}”`).join(', ');
    throw new ForbiddenException(
      limits.free === 1
        ? `You already have a Free workspace (${names}). Upgrade it to a paid plan to create another workspace.`
        : `You already have ${free.length} Free workspaces (${names}). Upgrade one to a paid plan to create another workspace.`,
      'WORKSPACE_LIMIT',
    );
  }
}

/**
 * Before moving a workspace to Free: none of its owners may already own the
 * maximum of Free workspaces (otherwise create-while-paid-then-downgrade would
 * get around the limit).
 */
export async function assertCanBecomeFree(q: Queryable, tenantId: string) {
  const limits = workspaceLimits();
  const owners = await q.query<{ user_id: string; name: string; is_platform_admin: boolean }[]>(
    `SELECT m.user_id, u.name, u.is_platform_admin FROM tenant_members m
       JOIN roles r ON r.id = m.role_id AND r.key = $2 AND r.tenant_id IS NULL
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.status = 'active'`,
    [tenantId, OWNER_ROLE_KEY],
  );
  for (const o of owners) {
    if (o.is_platform_admin) continue;
    const otherFree = (await ownedWorkspaces(q, o.user_id, tenantId)).filter((w) => w.plan === 'free');
    if (otherFree.length >= limits.free) {
      throw new ForbiddenException(
        `${o.name} already owns a Free workspace (${otherFree.map((w) => `“${w.name}”`).join(', ')}). Each person can own ${limits.free} Free workspace${limits.free === 1 ? '' : 's'}, so this one must stay on a paid plan.`,
        'WORKSPACE_LIMIT',
      );
    }
  }
}
