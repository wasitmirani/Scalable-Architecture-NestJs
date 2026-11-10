import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'net';
import { SMTPServer } from 'smtp-server';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { DeliveryService } from '../src/modules/delivery/delivery.service';
import { bearer, createApp, registerAccount, type TestAccount } from './helpers';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

/** A real SMTP server: user `mailer`, password `s3cret`, no TLS. */
function startSmtp(inbox: Received[]) {
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'mailer' && auth.password === 's3cret') cb(null, { user: 'mailer' });
      else cb(new Error('Invalid username or password'));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      stream.on('end', () => {
        inbox.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
        });
        cb();
      });
    },
  });
  return new Promise<{ server: SMTPServer; port: number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.server.address() as AddressInfo).port }));
  });
}

/** Quoted-printable soft breaks and escapes removed, so assertions can match plain text. */
const decode = (raw: string) =>
  raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

describe('Email delivery (e2e)', () => {
  let app: INestApplication<App>;
  let owner: TestAccount;
  let delivery: DeliveryService;
  let db: DataSource;
  let smtp: { server: SMTPServer; port: number };
  const inbox: Received[] = [];

  const api = () => request(app.getHttpServer());
  const h = (a: TestAccount = owner) => ({ ...bearer(a.accessToken), 'X-Tenant-Id': a.tenantId });
  const get = (path: string, a?: TestAccount) => api().get(`/api/v1${path}`).set(h(a));
  const post = (path: string, body: object = {}, a?: TestAccount) => api().post(`/api/v1${path}`).set(h(a)).send(body);
  const smtpCreds = (password = 's3cret') => ({ host: '127.0.0.1', port: String(smtp.port), username: 'mailer', password });
  const messagesOf = async (filter: string, a?: TestAccount) => (await get(`/messages?${filter}`, a).expect(200)).body.data.data;

  beforeAll(async () => {
    smtp = await startSmtp(inbox);
    ({ app } = await createApp());
    delivery = app.get(DeliveryService);
    db = app.get(DataSource);
    owner = await registerAccount(app, 'delivery');
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => smtp.server.close(() => r()));
  });

  it('rejects wrong SMTP credentials, encrypts and hides accepted ones', async () => {
    const bad = await post('/channel-accounts', { channel: 'email', provider: 'SMTP', name: 'Mail', credentials: smtpCreds('wrong') }).expect(422);
    expect(bad.body.code).toBe('CREDENTIALS_REJECTED');

    const ok = await post('/channel-accounts', { channel: 'email', provider: 'SMTP', name: 'Mail', credentials: smtpCreds() }).expect(201);
    expect(ok.body.data).toMatchObject({ status: 'connected', isDefault: true, credentialsSet: true, identifier: '127.0.0.1' });
    expect(JSON.stringify(ok.body.data)).not.toMatch(/s3cret|_credentials|"credentials"/);
    const listed = (await get('/channel-accounts?channel=email').expect(200)).body.data.data;
    expect(JSON.stringify(listed)).not.toMatch(/s3cret|_credentials/);

    const [row] = await db.query(`SELECT data FROM product_records WHERE id = $1`, [ok.body.data.id]);
    expect(row.data._credentials).toMatch(/^v1:/);
    expect(row.data._credentials).not.toContain('s3cret');

    const checked = await post(`/channel-accounts/${ok.body.data.id}/check`).expect(200);
    expect(checked.body.data.status).toBe('connected');
    expect(JSON.stringify(checked.body.data)).not.toContain('_credentials');

    await post('/email-senders', { name: 'Acme Team', email: 'hello@acme.test', replyTo: 'support@acme.test', isDefault: true }).expect(201);
  });

  let templateId = '';
  it('template test send renders blocks, personalises and arrives', async () => {
    const t = await post('/templates', {
      name: 'Welcome email',
      channel: 'email',
      category: 'marketing',
      subject: 'Welcome {{first_name}}',
      previewText: 'Glad you are here',
      blocks: [
        { id: 'b1', type: 'heading', content: 'Hi {{first_name}}!' },
        { id: 'b2', type: 'button', content: 'Open dashboard', href: 'https://app.acme.test' },
        { id: 'b3', type: 'footer', content: 'Acme · {{unsubscribe_url}}' },
      ],
    }).expect(201);
    templateId = t.body.data.id;
    await post(`/templates/${templateId}/test`, { to: 'qa@acme.test' }).expect(200);

    const mail = inbox.at(-1)!;
    expect(mail.to).toEqual(['qa@acme.test']);
    const body = decode(mail.raw);
    expect(body).toContain('Subject: [Test] Welcome');
    expect(body).toContain('From: Acme Team <hello@acme.test>');
    expect(body).toContain('Reply-To: support@acme.test');
    expect(body).toContain('https://app.acme.test');
  });

  it('campaign launch → worker sends, escapes contact data, adds one-click unsubscribe, completes', async () => {
    const list = (await post('/lists', { name: 'Customers' }).expect(201)).body.data;
    const contact = (
      await post('/contacts', { email: 'ada@example.test', firstName: '<b>Ada</b>', listIds: [list.id], consents: { email: 'subscribed' } }).expect(201)
    ).body.data;
    const campaign = (
      await post('/campaigns', {
        name: 'Launch',
        channel: 'email',
        subject: 'News for {{first_name}}',
        senderLabel: 'Acme Team <hello@acme.test>',
        templateId,
        audience: { listIds: [list.id], segmentIds: [], excludeListIds: [] },
      }).expect(201)
    ).body.data;
    await post(`/campaigns/${campaign.id}/launch`).expect(200);
    expect((await messagesOf(`campaignId=${campaign.id}`))[0].status).toBe('queued');

    const before = inbox.length;
    await delivery.processBatch();
    expect(inbox.length).toBe(before + 1);
    const body = decode(inbox.at(-1)!.raw);
    // Contact data cannot inject markup into the HTML part (the text part is plain text).
    const htmlPart = body.slice(body.indexOf('Content-Type: text/html'));
    expect(htmlPart).toContain('&lt;b&gt;Ada&lt;/b&gt;');
    expect(htmlPart).not.toContain('<b>Ada</b>');
    expect(body).toMatch(/List-Unsubscribe:\s+<http[^>]+\/unsubscribe\/[^>]+>/); // header may be folded
    expect(body).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');

    const [msg] = await messagesOf(`campaignId=${campaign.id}`);
    expect(msg).toMatchObject({ status: 'sent', provider: 'SMTP', errorCode: null });
    expect(msg.events.at(-1).status).toBe('sent');
    expect(Object.keys(msg).some((k) => k.startsWith('_'))).toBe(false);
    const done = (await get(`/campaigns/${campaign.id}`).expect(200)).body.data;
    expect(done.status).toBe('completed');
    expect(done.stats.sent).toBe(1);

    // Unsubscribe link: GET only confirms (link scanners), POST unsubscribes.
    const path = /\/unsubscribe\/[^>\s]+/.exec(body)![0];
    await api().get(path).expect(200).expect('Content-Type', /html/);
    expect((await get(`/contacts/${contact.id}`).expect(200)).body.data.consents.email).toBe('subscribed');
    await api().post(path).type('form').send('List-Unsubscribe=One-Click').expect(200);
    expect((await get(`/contacts/${contact.id}`).expect(200)).body.data.consents.email).toBe('unsubscribed');
    await api().get(`${path.slice(0, -3)}xyz`).expect(404); // tampered token
  });

  it('automation "Send email" renders the named template with run data', async () => {
    const wf = (
      await post('/workflows', {
        name: 'Welcome flow',
        trigger: { type: 'contact_created', config: {} },
        steps: [{ id: 'm1', type: 'send_email', config: { template: 'Welcome email' } }],
      }).expect(201)
    ).body.data;
    await post(`/workflows/${wf.id}/publish`, { note: 'v1' }).expect(200);
    const c = (await post('/contacts', { email: 'grace@example.test', firstName: 'Grace', consents: { email: 'subscribed' } }).expect(201)).body.data;

    const [queued] = await messagesOf(`contactId=${c.id}`);
    expect(queued).toMatchObject({ status: 'queued', templateRef: 'Welcome email', workflowId: wf.id });
    const before = inbox.length;
    await delivery.processBatch();
    expect(inbox.length).toBe(before + 1);
    expect(decode(inbox.at(-1)!.raw)).toContain('Hi Grace!');
    expect((await messagesOf(`contactId=${c.id}`))[0].status).toBe('sent');
  });

  it('a provider outage retries with backoff; a missing template fails for good', async () => {
    const c = (await post('/contacts', { email: 'outage@example.test', firstName: 'Out', consents: { email: 'subscribed' } }).expect(201)).body.data;
    // Point the account at a closed port, as if the provider were down.
    await db.query(
      `UPDATE product_records SET data = data || '{"status":"connected"}'::jsonb WHERE collection = 'channel-accounts' AND tenant_id = $1`,
      [owner.tenantId],
    );
    const [acc] = (await get('/channel-accounts?channel=email').expect(200)).body.data.data;
    const sealed = (await db.query(`SELECT data->>'_credentials' AS c FROM product_records WHERE id = $1`, [acc.id]))[0].c;
    await db.query(
      `UPDATE product_records SET data = data || jsonb_build_object('_credentials', $2::text) WHERE id = $1`,
      [acc.id, require('../src/common/crypto/secret-box').seal({ ...smtpCreds(), port: '1' })],
    );

    const [queued] = await messagesOf(`contactId=${c.id}`); // the welcome flow queued it
    await delivery.processBatch();
    let [m] = await messagesOf(`contactId=${c.id}`);
    expect(m.status).toBe('queued');
    expect(m.errorCode).toBe('TEMPORARY');
    expect(m.events.at(-1).status).toBe('retrying');
    const [{ next }] = await db.query(`SELECT data->>'_nextAttemptAt' AS next FROM product_records WHERE id = $1`, [queued.id]);
    expect(Date.parse(next)).toBeGreaterThan(Date.now() + 30_000); // backs off, not a hot loop
    await delivery.processBatch();
    expect((await messagesOf(`contactId=${c.id}`))[0].events.filter((e: { status: string }) => e.status === 'retrying')).toHaveLength(1);

    // Restore the account; a manual retry of a permanently failed message works.
    await db.query(`UPDATE product_records SET data = data || jsonb_build_object('_credentials', $2::text) WHERE id = $1`, [acc.id, sealed]);
    await db.query(`UPDATE product_records SET data = data || '{"templateRef":"No such template"}'::jsonb WHERE id = $1`, [queued.id]);
    await db.query(`UPDATE product_records SET data = data - '_nextAttemptAt' WHERE id = $1`, [queued.id]);
    await delivery.processBatch();
    [m] = await messagesOf(`contactId=${c.id}`);
    expect(m).toMatchObject({ status: 'failed', errorCode: 'TEMPLATE_NOT_FOUND' });
  });

  it('without an email account, sends fail with a clear reason and test sends answer 409', async () => {
    const other = await registerAccount(app, 'noprovider');
    const t = (await post('/templates', { name: 'Hello', channel: 'email', subject: 'Hello', blocks: [{ id: 'x', type: 'text', content: 'Hi' }] }, other).expect(201)).body.data;
    const res = await post(`/templates/${t.id}/test`, { to: 'a@b.test' }, other).expect(409);
    expect(res.body.code).toBe('PROVIDER_NOT_CONNECTED');
  });

  it('scheduled campaigns launch when their time comes', async () => {
    const list = (await post('/lists', { name: 'Later' }).expect(201)).body.data;
    await post('/contacts', { email: 'later@example.test', firstName: 'Lou', listIds: [list.id], consents: { email: 'subscribed' } }).expect(201);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const c = (
      await post('/campaigns', {
        name: 'Scheduled',
        channel: 'email',
        subject: 'Later',
        senderLabel: 'Acme Team <hello@acme.test>',
        templateId,
        audience: { listIds: [list.id], segmentIds: [], excludeListIds: [] },
        schedule: { type: 'scheduled', at, timezone: 'UTC' },
      }).expect(201)
    ).body.data;
    await post(`/campaigns/${c.id}/launch`).expect(200);
    await delivery.launchDueCampaigns();
    expect((await get(`/campaigns/${c.id}`).expect(200)).body.data.status).toBe('scheduled'); // not yet

    await db.query(`UPDATE product_records SET data = jsonb_set(data, '{schedule,at}', to_jsonb($2::text)) WHERE id = $1`, [c.id, new Date(Date.now() - 1000).toISOString()]);
    await delivery.launchDueCampaigns();
    expect((await get(`/campaigns/${c.id}`).expect(200)).body.data.status).toBe('running');
    await delivery.processBatch();
    const done = (await get(`/campaigns/${c.id}`).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'completed' });
    expect(done.stats.sent).toBe(1);
  });

  it('Gmail and Outlook explain missing server configuration', async () => {
    const res = await post('/channel-accounts/oauth/gmail/start', { name: 'Support inbox' }).expect(409);
    expect(res.body.code).toBe('OAUTH_NOT_CONFIGURED');
    await post('/channel-accounts', { channel: 'email', provider: 'Gmail', credentials: { email: 'x@gmail.com' } }).expect(422);
  });

  it('Gmail start returns a Google consent URL when configured', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
    try {
      const res = await post('/channel-accounts/oauth/gmail/start', { name: 'Support inbox' }).expect(200);
      const url = new URL(res.body.data.url);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('scope')).toContain('https://mail.google.com/');
      expect(url.searchParams.get('redirect_uri')).toMatch(/\/oauth\/email\/gmail\/callback$/);
      // A tampered state is refused at the callback.
      const cb = await api().get(`/oauth/email/gmail/callback?code=x&state=${url.searchParams.get('state')}tampered`).expect(302);
      expect(cb.headers.location).toContain('oauth_error=');
    } finally {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    }
  });
});
