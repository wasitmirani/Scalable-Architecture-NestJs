/**
 * Non-superuser role that tenant-scoped transactions switch to (SET LOCAL ROLE)
 * so PostgreSQL row-level security applies even when the connection user owns the tables.
 */
export function appRoleName(): string {
  const role = process.env.DB_APP_ROLE || 'birdcrm_app';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(`Invalid DB_APP_ROLE "${role}"`);
  }
  return role;
}
