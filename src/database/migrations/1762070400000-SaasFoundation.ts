import { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName } from '../app-role';

/**
 * Phase 1 — SaaS foundation: identity, tenancy, RBAC, invitations, API keys, audit.
 *
 * Tenant isolation is enforced twice: application queries always filter by tenant,
 * and row-level security applies whenever a transaction runs as the app role
 * (see TenantDb). System roles and permissions are reference data seeded here.
 */
export class SaasFoundation1762070400000 implements MigrationInterface {
  name = 'SaasFoundation1762070400000';

  public async up(q: QueryRunner): Promise<void> {
    const role = appRoleName();

    await q.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN;
        END IF;
      END $$`);
    await q.query(`GRANT ${role} TO CURRENT_USER`);
    await q.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await q.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );

    await q.query(`
      CREATE FUNCTION app_current_tenant() RETURNS uuid
      LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$`);

    // ---------- identity (global, not tenant-owned) ----------
    await q.query(`
      CREATE TABLE users (
        id                 uuid PRIMARY KEY DEFAULT uuidv7(),
        name               varchar(120) NOT NULL,
        email              varchar(254) NOT NULL,
        password_hash      varchar(255) NOT NULL,
        email_verified_at  timestamptz,
        status             varchar(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        is_platform_admin  boolean      NOT NULL DEFAULT false,
        failed_login_count integer      NOT NULL DEFAULT 0,
        locked_until       timestamptz,
        last_login_at      timestamptz,
        mfa_enabled        boolean      NOT NULL DEFAULT false,
        mfa_secret_enc     text,
        avatar_url         varchar(500),
        created_at         timestamptz  NOT NULL DEFAULT now(),
        updated_at         timestamptz  NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX users_email_uq ON users (lower(email))`);

    await q.query(`
      CREATE TABLE sessions (
        id             uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        user_agent     varchar(500),
        ip             varchar(64),
        created_at     timestamptz NOT NULL DEFAULT now(),
        last_used_at   timestamptz NOT NULL DEFAULT now(),
        expires_at     timestamptz NOT NULL,
        revoked_at     timestamptz,
        revoked_reason varchar(50)
      )`);
    await q.query(`CREATE INDEX sessions_user_idx ON sessions (user_id)`);

    await q.query(`
      CREATE TABLE refresh_tokens (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        used_at    timestamptz
      )`);
    await q.query(
      `CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id)`,
    );

    await q.query(`
      CREATE TABLE user_tokens (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        purpose    varchar(30) NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at    timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, purpose)`,
    );

    // ---------- tenancy ----------
    await q.query(`
      CREATE TABLE tenants (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        name       varchar(120) NOT NULL,
        slug       varchar(80)  NOT NULL UNIQUE,
        status     varchar(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz  NOT NULL DEFAULT now(),
        updated_at timestamptz  NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE tenant_settings (
        tenant_id  uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
        timezone   varchar(64) NOT NULL DEFAULT 'UTC',
        locale     varchar(16) NOT NULL DEFAULT 'en',
        settings   jsonb       NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);

    // ---------- access control ----------
    await q.query(`
      CREATE TABLE permissions (
        key         varchar(64)  PRIMARY KEY,
        category    varchar(40)  NOT NULL,
        description varchar(255) NOT NULL
      )`);

    await q.query(`
      CREATE TABLE roles (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id   uuid REFERENCES tenants (id) ON DELETE CASCADE,
        key         varchar(50)  NOT NULL,
        name        varchar(80)  NOT NULL,
        description varchar(255),
        is_system   boolean      NOT NULL DEFAULT false,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        updated_at  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT roles_system_scope_ck CHECK (is_system = (tenant_id IS NULL)),
        CONSTRAINT roles_id_tenant_uq UNIQUE (id, tenant_id)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX roles_system_key_uq ON roles (key) WHERE tenant_id IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX roles_tenant_key_uq ON roles (tenant_id, key) WHERE tenant_id IS NOT NULL`,
    );

    await q.query(`
      CREATE TABLE role_permissions (
        role_id        uuid        NOT NULL,
        permission_key varchar(64) NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
        tenant_id      uuid,
        PRIMARY KEY (role_id, permission_key),
        CONSTRAINT role_permissions_role_fk FOREIGN KEY (role_id, tenant_id)
          REFERENCES roles (id, tenant_id) ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE INDEX role_permissions_tenant_idx ON role_permissions (tenant_id)`,
    );

    await q.query(`
      CREATE TABLE tenant_members (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role_id    uuid NOT NULL REFERENCES roles (id),
        status     varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
        joined_at  timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenant_members_tenant_user_uq UNIQUE (tenant_id, user_id)
      )`);
    await q.query(
      `CREATE INDEX tenant_members_user_idx ON tenant_members (user_id)`,
    );

    await q.query(`
      CREATE TABLE invitations (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        email       varchar(254) NOT NULL,
        role_id     uuid NOT NULL REFERENCES roles (id),
        token_hash  char(64) NOT NULL UNIQUE,
        invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
        expires_at  timestamptz NOT NULL,
        accepted_at timestamptz,
        accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
        revoked_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE UNIQUE INDEX invitations_pending_uq ON invitations (tenant_id, lower(email))
      WHERE accepted_at IS NULL AND revoked_at IS NULL`);

    await q.query(`
      CREATE TABLE api_keys (
        id           uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        name         varchar(100) NOT NULL,
        prefix       varchar(16)  NOT NULL UNIQUE,
        secret_hash  char(64)     NOT NULL,
        scopes       text[]       NOT NULL DEFAULT '{}',
        created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
        last_used_at timestamptz,
        expires_at   timestamptz,
        revoked_at   timestamptz,
        created_at   timestamptz  NOT NULL DEFAULT now(),
        updated_at   timestamptz  NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id)`);

    // Append-only: no FK so entries outlive the rows they describe.
    await q.query(`
      CREATE TABLE audit_logs (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id   uuid,
        actor_type  varchar(20) NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
        actor_id    uuid,
        action      varchar(80) NOT NULL,
        target_type varchar(40),
        target_id   varchar(64),
        metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
        ip          varchar(64),
        user_agent  varchar(500),
        request_id  varchar(64),
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, id DESC)`,
    );

    // ---------- privileges for the app role ----------
    // Credentials and token tables are never needed inside a tenant transaction.
    await q.query(
      `REVOKE ALL ON sessions, refresh_tokens, user_tokens FROM ${role}`,
    );
    await q.query(`REVOKE ALL ON users FROM ${role}`);
    await q.query(
      `GRANT SELECT (id, name, email, avatar_url, created_at) ON users TO ${role}`,
    );
    await q.query(`REVOKE UPDATE, DELETE ON audit_logs FROM ${role}`);
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON permissions FROM ${role}`);

    // ---------- row-level security ----------
    const tenantScoped = [
      'tenant_members',
      'tenant_settings',
      'invitations',
      'api_keys',
    ];
    for (const table of tenantScoped) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${table}_isolation ON ${table}
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())`);
    }

    await q.query(`ALTER TABLE tenants ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY tenants_isolation ON tenants
      USING (id = app_current_tenant())
      WITH CHECK (id = app_current_tenant())`);

    // System roles (tenant_id NULL) are readable by every tenant but writable by none.
    for (const table of ['roles', 'role_permissions']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY ${table}_read ON ${table} FOR SELECT
        USING (tenant_id IS NULL OR tenant_id = app_current_tenant())`);
      await q.query(`
        CREATE POLICY ${table}_write ON ${table} FOR ALL
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())`);
    }

    await q.query(`ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY audit_logs_read ON audit_logs FOR SELECT
      USING (tenant_id = app_current_tenant())`);
    await q.query(`
      CREATE POLICY audit_logs_append ON audit_logs FOR INSERT
      WITH CHECK (tenant_id = app_current_tenant())`);

    // ---------- reference data ----------
    await q.query(`
      INSERT INTO permissions (key, category, description) VALUES
        ('tenant.read',      'workspace', 'View workspace details and settings'),
        ('tenant.update',    'workspace', 'Update workspace details and settings'),
        ('members.read',     'team',      'View team members and invitations'),
        ('members.manage',   'team',      'Invite, update and remove team members'),
        ('roles.read',       'team',      'View roles and permissions'),
        ('roles.manage',     'team',      'Create, update and delete custom roles'),
        ('api_keys.read',    'developer', 'View API keys'),
        ('api_keys.manage',  'developer', 'Create, rotate and revoke API keys'),
        ('audit.read',       'security',  'View the audit log')`);

    const systemRoles: Array<[string, string, string, string[] | '*']> = [
      ['owner', 'Owner', 'Full access, including ownership and billing', '*'],
      ['admin', 'Admin', 'Manages the workspace, team and integrations', '*'],
      [
        'marketing_manager',
        'Marketing manager',
        'Manages contacts, templates and campaigns',
        ['tenant.read', 'members.read'],
      ],
      [
        'support_agent',
        'Support agent',
        'Works in the shared inbox',
        ['tenant.read', 'members.read'],
      ],
      [
        'developer',
        'Developer',
        'Manages API keys, webhooks and integrations',
        ['tenant.read', 'members.read', 'api_keys.read', 'api_keys.manage'],
      ],
      [
        'viewer',
        'Viewer',
        'Read-only access to dashboards and reports',
        ['tenant.read', 'members.read', 'roles.read'],
      ],
    ];
    for (const [key, name, description, perms] of systemRoles) {
      await q.query(
        `INSERT INTO roles (key, name, description, is_system) VALUES ($1, $2, $3, true)`,
        [key, name, description],
      );
      await q.query(
        perms === '*'
          ? `INSERT INTO role_permissions (role_id, permission_key)
             SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
             WHERE r.key = $1 AND r.tenant_id IS NULL`
          : `INSERT INTO role_permissions (role_id, permission_key)
             SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key = ANY($2::text[])
             WHERE r.key = $1 AND r.tenant_id IS NULL`,
        perms === '*' ? [key] : [key, perms],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'audit_logs',
      'api_keys',
      'invitations',
      'tenant_members',
      'role_permissions',
      'roles',
      'permissions',
      'tenant_settings',
      'tenants',
      'user_tokens',
      'refresh_tokens',
      'sessions',
      'users',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await q.query(`DROP FUNCTION IF EXISTS app_current_tenant()`);
    await q.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${appRoleName()}`,
    );
  }
}
