import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  bearer,
  createApp,
  registerAccount,
  type TestAccount,
} from './helpers';

/** Package-wise limits: what each plan allows is enforced by the API. */
describe('Plan limits (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let free: TestAccount;

  const api = () => request(app.getHttpServer());
  const h = (a: TestAccount) => ({
    ...bearer(a.accessToken),
    'X-Tenant-Id': a.tenantId,
  });
  const post = (a: TestAccount, path: string, body: object = {}) =>
    api().post(`/api/v1${path}`).set(h(a)).send(body);
  const get = (a: TestAccount, path: string) =>
    api().get(`/api/v1${path}`).set(h(a));

  /** Fills a workspace with n contacts directly (fast), as an import would. */
  async function seedContacts(a: TestAccount, n: number) {
    await db.query(
      `INSERT INTO product_records (tenant_id, collection, data)
       SELECT $1, 'contacts', jsonb_build_object('email', 'seed' || g || '@example.test', 'firstName', 'Seed', 'tags', '[]'::jsonb, 'listIds', '[]'::jsonb, 'consents', '{"email":"none"}'::jsonb)
       FROM generate_series(1, $2) g`,
      [a.tenantId, n],
    );
  }

  beforeAll(async () => {
    ({ app } = await createApp());
    db = app.get(DataSource);
    free = await registerAccount(app, 'freeplan', { plan: 'free' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('the subscription reports the plan entitlements', async () => {
    const sub = (await get(free, '/billing/subscription').expect(200)).body
      .data;
    expect(sub.planId).toBe('free');
    expect(sub.entitlements).toMatchObject({
      contacts: 1000,
      emailsPerDay: 300,
      seats: 1,
      activeAutomations: 2,
    });
    expect(sub.entitlements.features).toMatchObject({
      segments: false,
      salesCrm: false,
      abTesting: false,
    });
  });

  it('Free blocks Business features with an upgrade hint', async () => {
    const seg = await post(free, '/segments', {
      name: 'VIP',
      rules: { match: 'all', rules: [] },
    }).expect(403);
    expect(seg.body).toMatchObject({ code: 'PLAN_LIMIT' });
    expect(seg.body.message).toMatch(/Upgrade to Business/);
    expect(
      (await post(free, '/deals', { title: 'Deal' }).expect(403)).body.code,
    ).toBe('PLAN_LIMIT');
    expect(
      (await post(free, '/companies', { name: 'Acme' }).expect(403)).body.code,
    ).toBe('PLAN_LIMIT');
  });

  it('Free allows one seat: inviting is refused', async () => {
    const roles = (await api().get(`/api/v1/roles`).set(h(free)).expect(200))
      .body.data;
    const viewer = roles.find((r: { key: string }) => r.key === 'viewer');
    const res = await api()
      .post('/api/v1/invitations')
      .set(h(free))
      .send({ email: 'teammate@example.test', roleId: viewer.id })
      .expect(403);
    expect(res.body.code).toBe('PLAN_LIMIT');
  });

  it('Free allows 2 live automations; pausing frees a slot', async () => {
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      const wf = (
        await post(free, '/workflows', {
          name,
          trigger: { type: 'contact_created', config: {} },
          steps: [{ id: `t${name}`, type: 'add_tag', config: { tag: name } }],
        }).expect(201)
      ).body.data;
      ids.push(wf.id);
    }
    await post(free, `/workflows/${ids[0]}/publish`, { note: '1' }).expect(200);
    await post(free, `/workflows/${ids[1]}/publish`, { note: '1' }).expect(200);
    const third = await post(free, `/workflows/${ids[2]}/publish`, {
      note: '1',
    }).expect(403);
    expect(third.body.message).toMatch(/2 live automations/);
    await post(free, `/workflows/${ids[0]}/pause`).expect(200);
    await post(free, `/workflows/${ids[2]}/publish`, { note: '1' }).expect(200);
    await post(free, `/workflows/${ids[0]}/resume`).expect(403); // the slot is taken again
    await post(free, `/workflows/${ids[2]}/pause`).expect(200);
    await post(free, `/workflows/${ids[1]}/pause`).expect(200);
  });

  it('contacts stop at the plan limit; imports keep what fits', async () => {
    await seedContacts(free, 998);
    await post(free, '/contacts', { email: 'fits@example.test' }).expect(201); // 999
    const res = await post(free, '/contacts/imports', {
      fileName: 'more.csv',
      rows: [{ e: 'a@x.test' }, { e: 'b@x.test' }, { e: 'c@x.test' }],
      mapping: { e: 'email' },
      listId: null,
      updateExisting: false,
    });
    expect(res.status).toBeLessThan(300);
    expect(res.body.data).toMatchObject({
      status: 'partial',
      created: 1,
      overLimit: 2,
    });
    expect(res.body.data.note).toMatch(/1,000 contacts/);
    const full = await post(free, '/contacts', {
      email: 'over@example.test',
    }).expect(403);
    expect(full.body).toMatchObject({ code: 'PLAN_LIMIT' });
    expect(full.body.message).toMatch(/full/);
  });

  it('a downgrade must fit current usage', async () => {
    const big = await registerAccount(app, 'downgrade', { plan: 'business' });
    await seedContacts(big, 1001);
    const res = await post(big, '/billing/subscription', {
      planId: 'free',
      cycle: 'monthly',
    }).expect(403);
    expect(res.body.message).toMatch(/1,001 contacts/);
    await post(big, '/billing/subscription', {
      planId: 'starter',
      cycle: 'monthly',
    }).expect((r) => expect(r.status).toBeLessThan(300));
  });

  it('A/B testing needs Starter; a campaign larger than the monthly allowance is refused', async () => {
    const small = await registerAccount(app, 'abtest', { plan: 'free' });
    const list = (await post(small, '/lists', { name: 'All' }).expect(201)).body
      .data;
    await post(small, '/contacts', {
      email: 'one@example.test',
      listIds: [list.id],
      consents: { email: 'subscribed' },
    }).expect(201);
    const base = {
      channel: 'email',
      subject: 'Hi',
      body: 'Hello',
      senderLabel: 'Team <team@example.test>',
      audience: { listIds: [list.id], segmentIds: [], excludeListIds: [] },
    };
    const ab = (
      await post(small, '/campaigns', {
        ...base,
        name: 'AB',
        abTest: {
          enabled: true,
          variantSubject: 'Hey',
          splitPercent: 20,
          winnerMetric: 'open',
        },
      }).expect(201)
    ).body.data;
    expect(
      (await post(small, `/campaigns/${ab.id}/launch`).expect(403)).body
        .message,
    ).toMatch(/A\/B testing/);

    // Use up this month's allowance as if 9,000 emails were sent.
    await db.query(
      `INSERT INTO product_records (tenant_id, collection, data)
       SELECT $1, 'messages', jsonb_build_object('channel', 'email', 'direction', 'outbound', 'status', 'sent', 'sentAt', now())
       FROM generate_series(1, 9000)`,
      [small.tenantId],
    );
    const normal = (
      await post(small, '/campaigns', { ...base, name: 'Normal' }).expect(201)
    ).body.data;
    const res = await post(small, `/campaigns/${normal.id}/launch`).expect(403);
    expect(res.body.message).toMatch(/0 left this month/);
  });
});
