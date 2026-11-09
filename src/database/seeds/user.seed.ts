import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { Helpers } from '../../common/utils/helpers';

/**
 * Development seed: a verified platform-admin user who owns a demo workspace.
 * Idempotent — does nothing if the user already exists.
 */
export async function seedDefaultUser(dataSource: DataSource): Promise<void> {
  const email = (
    process.env.SEED_ADMIN_EMAIL || 'admin@example.com'
  ).toLowerCase();
  const name = process.env.SEED_ADMIN_NAME || 'Admin';
  const password = process.env.SEED_ADMIN_PASSWORD || 'Password123!';

  const existing = await dataSource.query<unknown[]>(
    `SELECT 1 FROM users WHERE lower(email) = $1`,
    [email],
  );
  if (existing.length > 0) {
    console.log(`[seed] user already exists: ${email}`);
    return;
  }

  await dataSource.transaction(async (em) => {
    const [user] = await em.query<Array<{ id: string }>>(
      `INSERT INTO users (name, email, password_hash, email_verified_at, is_platform_admin)
       VALUES ($1, $2, $3, now(), true) RETURNING id`,
      [name, email, await bcrypt.hash(password, 12)],
    );
    const [tenant] = await em.query<Array<{ id: string }>>(
      `INSERT INTO tenants (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [
        'Demo Workspace',
        `${Helpers.generateSlug('Demo Workspace')}-${Date.now().toString(36)}`,
        user.id,
      ],
    );
    await em.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [
      tenant.id,
    ]);
    await em.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE key = 'owner' AND tenant_id IS NULL`,
      [tenant.id, user.id],
    );
  });
  console.log(
    `[seed] created platform admin ${email} with workspace "Demo Workspace"`,
  );
}
