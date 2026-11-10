import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import {
  bearer,
  createApp,
  registerAccount,
  type TestAccount,
} from './helpers';

/**
 * Automation triggers fire from real data changes and the Events API, chained
 * automations run, and "Wait for event" resumes when the event happens.
 */
describe('Automation triggers (e2e)', () => {
  let app: INestApplication<App>;
  let owner: TestAccount;

  const api = () => request(app.getHttpServer());
  const h = () => ({
    ...bearer(owner.accessToken),
    'X-Tenant-Id': owner.tenantId,
  });
  const get = (path: string) => api().get(`/api/v1${path}`).set(h());
  const post = (path: string, body: object = {}) =>
    api().post(`/api/v1${path}`).set(h()).send(body);
  const patch = (path: string, body: object) =>
    api().patch(`/api/v1${path}`).set(h()).send(body);

  let n = 0;
  const id = () => `s${++n}`;
  const tag = (value: string) => ({
    id: id(),
    type: 'add_tag',
    config: { tag: value },
  });

  /** Creates and publishes a workflow; returns its id. */
  async function live(name: string, trigger: object, steps: object[]) {
    const created = await post('/workflows', { name, trigger, steps }).expect(
      201,
    );
    const wfId = created.body.data.id as string;
    await post(`/workflows/${wfId}/publish`, { note: 'test' }).expect(200);
    return wfId;
  }

  const contact = async (cid: string) =>
    (await get(`/contacts/${cid}`).expect(200)).body.data;
  const runs = async (wfId: string) =>
    (await get(`/workflows/${wfId}/runs`).expect(200)).body.data.data as Array<{
      status: string;
      contactId: string;
      variables: Record<string, string>;
      log: Array<{ message: string }>;
    }>;

  beforeAll(async () => {
    ({ app } = await createApp());
    owner = await registerAccount(app, 'triggers');
  });

  afterAll(async () => {
    await app.close();
  });

  it('added to list → tag, and the tag chains into a "Tag added" automation', async () => {
    const list = (await post('/lists', { name: 'Newsletter' }).expect(201)).body
      .data;
    const welcome = await live(
      'Welcome',
      { type: 'added_to_list', config: { listId: list.id } },
      [tag('welcomed')],
    );
    const chained = await live(
      'Chained',
      { type: 'tag_added', config: { tag: 'Welcomed' } },
      [tag('chained')],
    );

    const c = (
      await post('/contacts', {
        email: 'list.join@example.test',
        listIds: [list.id],
      }).expect(201)
    ).body.data;

    expect((await runs(welcome)).map((r) => r.contactId)).toEqual([c.id]);
    expect((await runs(chained)).map((r) => r.contactId)).toEqual([c.id]);
    expect((await contact(c.id)).tags).toEqual(
      expect.arrayContaining(['welcomed', 'chained']),
    );

    // Joining a different list does not match.
    const other = (await post('/lists', { name: 'Other' }).expect(201)).body
      .data;
    await patch(`/contacts/${c.id}`, { listIds: [list.id, other.id] }).expect(
      200,
    );
    expect(await runs(welcome)).toHaveLength(1);
  });

  it('contact created fires once; blocklisted contacts are not enrolled', async () => {
    const wf = await live(
      'New contacts',
      { type: 'contact_created', config: {} },
      [tag('onboarded')],
    );
    const a = (
      await post('/contacts', { email: 'created@example.test' }).expect(201)
    ).body.data;
    await post('/contacts', {
      email: 'blocked@example.test',
      blocklisted: true,
    }).expect(201);
    await patch(`/contacts/${a.id}`, { firstName: 'Ada' }).expect(200); // an update is not a creation

    const r = await runs(wf);
    expect(r.map((x) => x.contactId)).toEqual([a.id]);
    // Its tag would count as "gets a tag" for the wait test below.
    await post(`/workflows/${wf}/pause`).expect(200);
  });

  it('deal stage changed matches the stage name and exposes the deal', async () => {
    const wf = await live(
      'Qualified deals',
      { type: 'deal_stage_changed', config: { stage: 'Qualified' } },
      [tag('sql')],
    );
    const pipeline = (await get('/pipelines').expect(200)).body.data.data[0];
    const c = (
      await post('/contacts', { email: 'deal@example.test' }).expect(201)
    ).body.data;
    const deal = (
      await post('/deals', {
        title: 'Big deal',
        value: 4800,
        pipelineId: pipeline.id,
        stageId: 'stage-new',
        contactId: c.id,
      }).expect(201)
    ).body.data;
    expect(await runs(wf)).toHaveLength(0); // created in a stage, not moved

    await patch(`/deals/${deal.id}`, { stageId: 'stage-demo' }).expect(200);
    expect(await runs(wf)).toHaveLength(0); // wrong stage
    await patch(`/deals/${deal.id}`, { stageId: 'stage-qualified' }).expect(
      200,
    );

    const [run] = await runs(wf);
    expect(run.contactId).toBe(c.id);
    expect((await contact(c.id)).tags).toContain('sql');
  });

  it('Events API: API key with events.write starts "Custom event" automations', async () => {
    const wf = await live(
      'Refunds',
      { type: 'webhook', config: { event: 'order.refunded' } },
      [tag('refunded')],
    );
    const key = (
      await api()
        .post('/api/v1/api-keys')
        .set(h())
        .send({ name: 'Backend', scopes: ['events.write'] })
        .expect(201)
    ).body.data.key as string;

    const res = await api()
      .post('/api/v1/events')
      .set({ 'X-Api-Key': key })
      .send({
        event: 'order.refunded',
        contact: { email: 'New.Buyer@example.test' },
        properties: { order: { id: 'A-17' }, amount: 40 },
      })
      .expect(202);
    expect(res.body.data).toMatchObject({
      event: 'order.refunded',
      contactCreated: true,
      enrolled: 1,
    });

    const [run] = await runs(wf);
    expect((await contact(run.contactId)).email).toBe('new.buyer@example.test');
    expect((await contact(run.contactId)).tags).toContain('refunded');

    // Other event names do not match; bad input is rejected.
    await api()
      .post('/api/v1/events')
      .set({ 'X-Api-Key': key })
      .send({
        event: 'order.created',
        contact: { email: 'new.buyer@example.test' },
      })
      .expect(202);
    expect(await runs(wf)).toHaveLength(1);
    await api()
      .post('/api/v1/events')
      .set({ 'X-Api-Key': key })
      .send({ event: 'Bad Name', contact: { email: 'x@example.test' } })
      .expect(422);
    await api()
      .post('/api/v1/events')
      .set({ 'X-Api-Key': key })
      .send({ event: 'order.refunded' })
      .expect(422);

    // A key without the scope is refused.
    const weak = (
      await api()
        .post('/api/v1/api-keys')
        .set(h())
        .send({ name: 'Weak', scopes: ['contacts.read'] })
        .expect(201)
    ).body.data.key;
    await api()
      .post('/api/v1/events')
      .set({ 'X-Api-Key': weak })
      .send({ event: 'order.refunded', contact: { email: 'x@example.test' } })
      .expect(403);
  });

  it('Wait for event waits for the real event, then takes the "happened" path', async () => {
    const waitStep = {
      id: id(),
      type: 'wait_for_event',
      config: { event: 'tag_added', timeoutAmount: '2', timeoutUnit: 'days' },
      paths: [
        {
          id: 'p-happened',
          label: 'Event happened',
          match: 'all',
          conditions: [],
          steps: [tag('engaged')],
        },
        {
          id: 'p-timeout',
          label: 'Timed out',
          match: 'all',
          conditions: [],
          isElse: true,
          steps: [tag('cold')],
        },
      ],
    };
    const wf = await live(
      'Engagement',
      { type: 'webhook', config: { event: 'trial.started' } },
      [waitStep],
    );
    const key = (
      await api()
        .post('/api/v1/api-keys')
        .set(h())
        .send({ name: 'Wait', scopes: ['events.write'] })
        .expect(201)
    ).body.data.key;
    await api()
      .post('/api/v1/events')
      .set({ 'X-Api-Key': key })
      .send({
        event: 'trial.started',
        contact: { email: 'waiter@example.test' },
        properties: { plan: 'pro' },
      })
      .expect(202);

    let [run] = await runs(wf);
    expect(run.status).toBe('waiting'); // not a simulated outcome
    const cid = run.contactId;
    expect((await contact(cid)).tags ?? []).not.toContain('cold');

    await patch(`/contacts/${cid}`, { tags: ['vip'] }).expect(200); // the awaited event
    [run] = await runs(wf);
    expect(run.status).toBe('completed');
    expect(run.log.some((l) => l.message.startsWith('Event happened'))).toBe(
      true,
    );
    const tags = (await contact(cid)).tags;
    expect(tags).toContain('engaged');
    expect(tags).not.toContain('cold');
  });
});
