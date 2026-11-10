import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Events API (`POST /events`, custom-event automation trigger): adds the
 * `events.write` permission so API keys can be scoped to it, and grants it to
 * the roles that manage API keys and integrations.
 */
const ROLES = ['owner', 'admin', 'developer'];

export class EventsApi1763020800000 implements MigrationInterface {
  name = 'EventsApi1763020800000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `INSERT INTO permissions (key, category, description)
       VALUES ('events.write', 'automations', 'Track custom events through the Events API')
       ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category, description = EXCLUDED.description`,
    );
    await q.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, 'events.write' FROM roles r
       WHERE r.key = ANY($1::text[]) AND r.tenant_id IS NULL
       ON CONFLICT DO NOTHING`,
      [ROLES],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DELETE FROM role_permissions WHERE permission_key = 'events.write'`,
    );
    await q.query(`DELETE FROM permissions WHERE key = 'events.write'`);
  }
}
