import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Product modules (CRM, sales, inbox, messaging, campaigns, automations, voice,
 * platform) store their rows in one tenant-scoped JSONB table, keyed by collection.
 * The API contract (docs/API-CONTRACT.md) stays the same if a collection later
 * moves to its own normalized table.
 *
 * Also adds the product permission catalogue and grants it to the built-in roles,
 * mirroring ROLE_PRESETS in frontend-react/src/constants/permissions.constants.ts.
 */
const PRODUCT_PERMISSIONS: Array<[string, string, string]> = [
  ['contacts.read', 'contacts', 'View contacts, lists and segments'],
  [
    'contacts.manage',
    'contacts',
    'Create, edit and delete contacts, lists and segments',
  ],
  ['contacts.import', 'contacts', 'Import contacts from files'],
  ['contacts.export', 'contacts', 'Export contacts and their data'],
  ['deals.read', 'sales', 'View deals, pipelines and tasks'],
  ['deals.manage', 'sales', 'Create, move and close deals'],
  ['inbox.read', 'inbox', 'Read conversations'],
  ['inbox.reply', 'inbox', 'Reply to conversations'],
  ['inbox.assign', 'inbox', 'Assign and close conversations'],
  ['campaigns.read', 'campaigns', 'View campaigns and their reports'],
  ['campaigns.manage', 'campaigns', 'Create and edit campaign drafts'],
  ['campaigns.send', 'campaigns', 'Launch, schedule and stop campaigns'],
  ['automations.read', 'automations', 'View automations and their runs'],
  ['automations.manage', 'automations', 'Create and edit automation drafts'],
  [
    'automations.publish',
    'automations',
    'Publish, pause and resume automations',
  ],
  [
    'templates.manage',
    'content',
    'Create, edit and submit templates and the brand kit',
  ],
  ['messages.read', 'content', 'View message logs and delivery events'],
  [
    'channels.manage',
    'channels',
    'Connect channels, numbers, domains and senders',
  ],
  ['voice.read', 'channels', 'View calls and recordings'],
  ['voice.manage', 'channels', 'Manage numbers, IVR menus and call routing'],
  [
    'integrations.manage',
    'developer',
    'Connect and disconnect third-party apps',
  ],
  ['webhooks.manage', 'developer', 'Manage webhook endpoints and deliveries'],
  ['billing.read', 'billing', 'View plan, usage and invoices'],
  ['billing.manage', 'billing', 'Change plan and payment details'],
];

const ALL_PRODUCT = PRODUCT_PERMISSIONS.map(([key]) => key);
const startsWith = (...prefixes: string[]) =>
  ALL_PRODUCT.filter((k) => prefixes.some((p) => k.startsWith(`${p}.`)));

/** Product permissions added to each built-in role (foundation grants are unchanged). */
const ROLE_GRANTS: Record<string, string[]> = {
  owner: ALL_PRODUCT,
  admin: ALL_PRODUCT.filter((k) => k !== 'billing.manage'),
  marketing_manager: [
    ...startsWith(
      'contacts',
      'campaigns',
      'automations',
      'templates',
      'messages',
    ),
    'inbox.read',
    'deals.read',
    'billing.read',
  ],
  sales_rep: [
    'contacts.read',
    'contacts.manage',
    'deals.read',
    'deals.manage',
    'inbox.read',
    'inbox.reply',
    'campaigns.read',
  ],
  support_agent: [
    'inbox.read',
    'inbox.reply',
    'inbox.assign',
    'contacts.read',
    'messages.read',
    'voice.read',
  ],
  developer: [
    ...startsWith('webhooks', 'integrations', 'channels'),
    'messages.read',
    'automations.read',
  ],
  viewer: ALL_PRODUCT.filter((k) => k.endsWith('.read')),
};

export class ProductRecords1762934400000 implements MigrationInterface {
  name = 'ProductRecords1762934400000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE product_records (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        collection  varchar(48) NOT NULL,
        data        jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_records_data_object_ck CHECK (jsonb_typeof(data) = 'object')
      )`);
    await q.query(
      `CREATE INDEX product_records_list_idx ON product_records (tenant_id, collection, created_at DESC)`,
    );
    await q.query(
      `CREATE INDEX product_records_data_idx ON product_records USING gin (data jsonb_path_ops)`,
    );
    await q.query(`ALTER TABLE product_records ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY product_records_isolation ON product_records
      USING (tenant_id = app_current_tenant())
      WITH CHECK (tenant_id = app_current_tenant())`);

    // Permission catalogue
    for (const [key, category, description] of PRODUCT_PERMISSIONS) {
      await q.query(
        `INSERT INTO permissions (key, category, description) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category, description = EXCLUDED.description`,
        [key, category, description],
      );
    }

    // Sales rep is a built-in role in the UI presets but was missing from the foundation.
    await q.query(
      `INSERT INTO roles (key, name, description, is_system)
       SELECT 'sales_rep', 'Sales rep', 'Deals and contacts, replies to leads', true
       WHERE NOT EXISTS (SELECT 1 FROM roles WHERE key = 'sales_rep' AND tenant_id IS NULL)`,
    );
    await q.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key = ANY($1::text[])
       WHERE r.key = 'sales_rep' AND r.tenant_id IS NULL
       ON CONFLICT DO NOTHING`,
      [['tenant.read', 'members.read']],
    );

    for (const [role, perms] of Object.entries(ROLE_GRANTS)) {
      await q.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key = ANY($2::text[])
         WHERE r.key = $1 AND r.tenant_id IS NULL
         ON CONFLICT DO NOTHING`,
        [role, perms],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS product_records`);
    await q.query(
      `DELETE FROM role_permissions WHERE permission_key = ANY($1::text[])`,
      [ALL_PRODUCT],
    );
    await q.query(`DELETE FROM permissions WHERE key = ANY($1::text[])`, [
      ALL_PRODUCT,
    ]);
    await q.query(
      `DELETE FROM roles WHERE key = 'sales_rep' AND tenant_id IS NULL`,
    );
  }
}
