import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { TenantDb } from '../src/database/database.module';
import {
  bearer,
  createApp,
  MailOutbox,
  registerAccount,
  TestAccount,
} from './helpers';

/**
 * Phase 1 acceptance: cross-tenant reads and writes are blocked at the API
 * layer and, independently, by PostgreSQL row-level security.
 */
describe('Tenant isolation & access control (e2e)', () => {
  let app: INestApplication<App>;
  let mail: MailOutbox;
  let a: TestAccount;
  let b: TestAccount;
  const http = () => request(app.getHttpServer());
  const asUser = (acct: TestAccount, tenantId = acct.tenantId) => ({
    ...bearer(acct.accessToken),
    'X-Tenant-Id': tenantId,
  });

  const roleId = async (acct: TestAccount, key: string): Promise<string> => {
    const res = await http().get('/api/v1/roles').set(asUser(acct)).expect(200);
    return res.body.data.find((r: { key: string }) => r.key === key).id;
  };

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    a = await registerAccount(app, 'tenant-a');
    b = await registerAccount(app, 'tenant-b');
  });
  afterAll(() => app.close());

  describe('API layer', () => {
    it.each([
      ['GET', (t: string) => `/api/v1/tenants/${t}`],
      ['GET', (t: string) => `/api/v1/tenants/${t}/members`],
      ['GET', (t: string) => `/api/v1/tenants/${t}/settings`],
    ])('%s %s on another tenant is forbidden', async (_method, path) => {
      const res = await http()
        .get(path(a.tenantId))
        .set(bearer(b.accessToken))
        .expect(403);
      expect(res.body.code).toBe('NOT_A_MEMBER');
    });

    it.each([
      '/api/v1/roles',
      '/api/v1/invitations',
      '/api/v1/api-keys',
      '/api/v1/audit-logs',
    ])('GET %s with a foreign X-Tenant-Id is forbidden', async (path) => {
      const res = await http().get(path).set(asUser(b, a.tenantId)).expect(403);
      expect(res.body.code).toBe('NOT_A_MEMBER');
    });

    it('writes to another tenant are forbidden', async () => {
      await http()
        .patch(`/api/v1/tenants/${a.tenantId}`)
        .set(bearer(b.accessToken))
        .send({ name: 'Hijacked' })
        .expect(403);
      await http()
        .post('/api/v1/invitations')
        .set(asUser(b, a.tenantId))
        .send({ email: 'x@example.test', roleId: await roleId(b, 'viewer') })
        .expect(403);
      const tenant = await http()
        .get(`/api/v1/tenants/${a.tenantId}`)
        .set(bearer(a.accessToken))
        .expect(200);
      expect(tenant.body.data.name).toBe('tenant-a workspace');
    });

    it('tenant-scoped routes require a tenant', async () => {
      const res = await http()
        .get('/api/v1/roles')
        .set(bearer(a.accessToken))
        .expect(400);
      expect(res.body.code).toBe('TENANT_REQUIRED');
    });

    it("a tenant cannot use another tenant's custom role", async () => {
      const created = await http()
        .post('/api/v1/roles')
        .set(asUser(a))
        .send({ name: 'A only', permissions: ['tenant.read'] })
        .expect(201);
      const res = await http()
        .post('/api/v1/invitations')
        .set(asUser(b))
        .send({ email: 'someone@example.test', roleId: created.body.data.id })
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('database layer (RLS)', () => {
    let tenantDb: TenantDb;
    beforeAll(() => {
      tenantDb = app.get(TenantDb);
    });

    it('runs tenant transactions as the non-superuser app role', async () => {
      const [row] = await tenantDb.run(b.tenantId, (em) =>
        em.query(
          `SELECT current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
        ),
      );
      expect(row.super).toBe(false);
    });

    it('hides other tenants rows even when the query does not filter', async () => {
      const rows = await tenantDb.run(b.tenantId, (em) =>
        em.query(`SELECT DISTINCT tenant_id FROM tenant_members`),
      );
      expect(rows).toEqual([{ tenant_id: b.tenantId }]);

      const [{ count }] = await tenantDb.run(b.tenantId, (em) =>
        em.query(`SELECT count(*)::int AS count FROM tenants WHERE id = $1`, [
          a.tenantId,
        ]),
      );
      expect(count).toBe(0);
    });

    it('rejects inserts into another tenant', async () => {
      await expect(
        tenantDb.run(b.tenantId, (em) =>
          em.query(
            `INSERT INTO api_keys (tenant_id, name, prefix, secret_hash) VALUES ($1, 'x', 'deadbeef0000', repeat('0', 64))`,
            [a.tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot read credentials tables at all', async () => {
      await expect(
        tenantDb.run(b.tenantId, (em) => em.query(`SELECT * FROM sessions`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        tenantDb.run(b.tenantId, (em) =>
          em.query(`SELECT password_hash FROM users`),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('audit log is append-only for the app role', async () => {
      await expect(
        tenantDb.run(a.tenantId, (em) =>
          em.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [a.tenantId]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('invitations and permissions', () => {
    let invitee: TestAccount;

    it('owner invites a viewer who accepts and gets read-only access', async () => {
      invitee = await registerAccount(app, 'invitee');
      await http()
        .post('/api/v1/invitations')
        .set(asUser(a))
        .send({ email: invitee.email, roleId: await roleId(a, 'viewer') })
        .expect(201);

      const token = mail.tokenFor(invitee.email, 'invite');
      const preview = await http()
        .get(`/api/v1/invitations/preview?token=${token}`)
        .expect(200);
      expect(preview.body.data.tenantName).toBe('tenant-a workspace');

      // Someone else holding the link cannot use it.
      const mismatch = await http()
        .post('/api/v1/invitations/accept')
        .set(bearer(b.accessToken))
        .send({ token })
        .expect(403);
      expect(mismatch.body.code).toBe('INVITATION_EMAIL_MISMATCH');

      await http()
        .post('/api/v1/invitations/accept')
        .set(bearer(invitee.accessToken))
        .send({ token })
        .expect(200);
      await http()
        .post('/api/v1/invitations/accept')
        .set(bearer(invitee.accessToken))
        .send({ token })
        .expect(400);

      await http()
        .get(`/api/v1/tenants/${a.tenantId}/members`)
        .set(bearer(invitee.accessToken))
        .expect(200);
      const denied = await http()
        .post('/api/v1/invitations')
        .set(asUser(invitee, a.tenantId))
        .send({ email: 'z@example.test', roleId: await roleId(a, 'viewer') })
        .expect(403);
      expect(denied.body.code).toBe('MISSING_PERMISSION');
    });

    it('members cannot grant permissions they do not hold', async () => {
      const inviterRole = await http()
        .post('/api/v1/roles')
        .set(asUser(a))
        .send({
          name: 'Team inviter',
          permissions: [
            'tenant.read',
            'members.read',
            'members.manage',
            'roles.read',
          ],
        })
        .expect(201);
      const members = await http()
        .get(`/api/v1/tenants/${a.tenantId}/members`)
        .set(bearer(a.accessToken))
        .expect(200);
      const inviteeMember = members.body.data.find(
        (m: { user: { id: string } }) => m.user.id === invitee.userId,
      );
      await http()
        .patch(`/api/v1/tenants/${a.tenantId}/members/${inviteeMember.id}`)
        .set(bearer(a.accessToken))
        .send({ roleId: inviterRole.body.data.id })
        .expect(200);

      const escalate = await http()
        .post('/api/v1/invitations')
        .set(asUser(invitee, a.tenantId))
        .send({
          email: 'admin-wannabe@example.test',
          roleId: await roleId(a, 'admin'),
        })
        .expect(403);
      expect(escalate.body.code).toBe('PERMISSION_ESCALATION');

      await http()
        .post('/api/v1/invitations')
        .set(asUser(invitee, a.tenantId))
        .send({
          email: 'new-viewer@example.test',
          roleId: await roleId(a, 'viewer'),
        })
        .expect(201);
    });

    it('the last owner cannot leave or be demoted', async () => {
      const leave = await http()
        .post(`/api/v1/tenants/${b.tenantId}/leave`)
        .set(bearer(b.accessToken))
        .expect(400);
      expect(leave.body.code).toBe('LAST_OWNER');

      const members = await http()
        .get(`/api/v1/tenants/${b.tenantId}/members`)
        .set(bearer(b.accessToken))
        .expect(200);
      const demote = await http()
        .patch(
          `/api/v1/tenants/${b.tenantId}/members/${members.body.data[0].id}`,
        )
        .set(bearer(b.accessToken))
        .send({ roleId: await roleId(b, 'viewer') })
        .expect(400);
      expect(demote.body.code).toBe('LAST_OWNER');
    });
  });

  describe('API keys', () => {
    let key: string;
    let keyId: string;

    it('creates a key that is shown once and never listed', async () => {
      const res = await http()
        .post('/api/v1/api-keys')
        .set(asUser(a))
        .send({ name: 'Read members', scopes: ['tenant.read', 'members.read'] })
        .expect(201);
      key = res.body.data.key;
      keyId = res.body.data.apiKey.id;
      expect(key).toMatch(/^bk_[0-9a-f]{12}_/);

      const list = await http()
        .get('/api/v1/api-keys')
        .set(asUser(a))
        .expect(200);
      expect(JSON.stringify(list.body)).not.toContain(key.split('_').pop());
      expect(list.body.data[0]).not.toHaveProperty('secretHash');
    });

    it('a read-only key can read but not write or exceed its scopes', async () => {
      await http()
        .get(`/api/v1/tenants/${a.tenantId}/members`)
        .set('X-Api-Key', key)
        .expect(200);
      await http().get('/api/v1/roles').set('X-Api-Key', key).expect(403);
      const write = await http()
        .post('/api/v1/invitations')
        .set('X-Api-Key', key)
        .send({ email: 'k@example.test', roleId: await roleId(a, 'viewer') })
        .expect(403);
      expect(write.body.code).toBe('MISSING_PERMISSION');
    });

    it('a key is bound to its own tenant', async () => {
      const res = await http()
        .get(`/api/v1/tenants/${b.tenantId}/members`)
        .set('X-Api-Key', key)
        .expect(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
      await http()
        .get('/api/v1/roles')
        .set('X-Api-Key', key)
        .set('X-Tenant-Id', b.tenantId)
        .expect(403);
    });

    it('keys cannot use account endpoints', async () => {
      const res = await http()
        .get('/api/v1/auth/me')
        .set('X-Api-Key', key)
        .expect(403);
      expect(res.body.code).toBe('USER_ONLY');
    });

    it('keys cannot be created with scopes the creator lacks', async () => {
      const res = await http()
        .post('/api/v1/api-keys')
        .set(asUser(a))
        .send({ name: 'Bad', scopes: ['does.not_exist'] })
        .expect(400);
      expect(res.body.code).toBe('UNKNOWN_PERMISSION');
    });

    it('rotated and revoked keys stop working', async () => {
      const rotated = await http()
        .post(`/api/v1/api-keys/${keyId}/rotate`)
        .set(asUser(a))
        .expect(200);
      await http()
        .get(`/api/v1/tenants/${a.tenantId}`)
        .set('X-Api-Key', key)
        .expect(401);
      const newKey = rotated.body.data.key;
      await http()
        .get(`/api/v1/tenants/${a.tenantId}`)
        .set('X-Api-Key', newKey)
        .expect(200);

      await http()
        .delete(`/api/v1/api-keys/${keyId}`)
        .set(asUser(a))
        .expect(200);
      const res = await http()
        .get(`/api/v1/tenants/${a.tenantId}`)
        .set('X-Api-Key', newKey)
        .expect(401);
      expect(res.body.code).toBe('INVALID_API_KEY');
    });
  });

  describe('audit log', () => {
    it('records security-sensitive actions per tenant only', async () => {
      const resA = await http()
        .get('/api/v1/audit-logs?limit=100')
        .set(asUser(a))
        .expect(200);
      const actionsA = resA.body.data.items.map(
        (e: { action: string }) => e.action,
      );
      expect(actionsA).toEqual(
        expect.arrayContaining([
          'tenant.created',
          'invitation.created',
          'invitation.accepted',
          'api_key.created',
          'api_key.revoked',
          'role.created',
        ]),
      );
      expect(
        resA.body.data.items.every(
          (e: { tenantId: string }) => e.tenantId === a.tenantId,
        ),
      ).toBe(true);

      const resB = await http()
        .get('/api/v1/audit-logs?limit=100')
        .set(asUser(b))
        .expect(200);
      expect(
        resB.body.data.items.every(
          (e: { tenantId: string }) => e.tenantId === b.tenantId,
        ),
      ).toBe(true);
    });

    it('paginates with a cursor', async () => {
      const page1 = await http()
        .get('/api/v1/audit-logs?limit=2')
        .set(asUser(a))
        .expect(200);
      expect(page1.body.data.items).toHaveLength(2);
      const page2 = await http()
        .get(`/api/v1/audit-logs?limit=2&cursor=${page1.body.data.nextCursor}`)
        .set(asUser(a))
        .expect(200);
      expect(page2.body.data.items[0].id < page1.body.data.items[1].id).toBe(
        true,
      );
    });
  });
});
