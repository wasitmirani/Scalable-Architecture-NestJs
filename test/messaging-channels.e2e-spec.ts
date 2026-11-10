import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { open } from '../src/common/crypto/secret-box';
import { DeliveryService } from '../src/modules/delivery/delivery.service';
import { twilioSignature } from '../src/modules/delivery/channel-webhooks.controller';
import {
  bearer,
  createApp,
  registerAccount,
  type TestAccount,
} from './helpers';

interface Call {
  method: string;
  path: string;
  body: string;
}

/** Fake Twilio, Meta Graph and Telegram Bot APIs, recording every call. */
function startProviders(calls: Call[]) {
  const json = (
    res: import('http').ServerResponse,
    status: number,
    body: unknown,
  ) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      calls.push({ method: req.method ?? '', path, body });
      // Twilio
      if (/^\/2010-04-01\/Accounts\/AC[^/]+\.json$/.test(path))
        return json(res, 200, { status: 'active', friendly_name: 'Acme SMS' });
      if (/\/Messages\.json$/.test(path)) {
        const to = new URLSearchParams(body).get('To');
        if (to === '+15550000000')
          return json(res, 400, {
            code: 21211,
            message: "The 'To' number is not a valid phone number.",
          });
        return json(res, 201, {
          sid: `SM${calls.length}`,
          num_segments: '1',
          status: 'queued',
        });
      }
      // Meta Graph
      if (req.method === 'GET' && /^\/v21\.0\/PN1\?/.test(path))
        return json(res, 200, {
          display_phone_number: '+1 415 555 0199',
          verified_name: 'Acme',
          quality_rating: 'GREEN',
        });
      if (path === '/v21.0/PN1/messages')
        return json(res, 200, { messages: [{ id: `wamid.${calls.length}` }] });
      if (req.method === 'POST' && path === '/v21.0/WABA1/message_templates')
        return json(res, 200, { id: 'TPL1', status: 'PENDING' });
      if (
        req.method === 'GET' &&
        path.startsWith('/v21.0/WABA1/message_templates')
      )
        return json(res, 200, { data: [{ status: 'APPROVED' }] });
      // Telegram
      if (path.endsWith('/getMe'))
        return json(res, 200, { ok: true, result: { username: 'acme_bot' } });
      if (path.endsWith('/sendMessage'))
        return json(res, 200, { ok: true, result: { message_id: 77 } });
      json(res, 404, { error: { message: `no fake for ${path}` } });
    });
  });
  return new Promise<{ server: Server; base: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    ),
  );
}

describe('SMS, WhatsApp and Telegram (e2e)', () => {
  let app: INestApplication<App>;
  let owner: TestAccount;
  let delivery: DeliveryService;
  let providers: { server: Server; base: string };
  const calls: Call[] = [];

  const api = () => request(app.getHttpServer());
  const h = () => ({
    ...bearer(owner.accessToken),
    'X-Tenant-Id': owner.tenantId,
  });
  const get = (path: string) => api().get(`/api/v1${path}`).set(h());
  const post = (path: string, body: object = {}) =>
    api().post(`/api/v1${path}`).set(h()).send(body);
  const lastCall = (match: RegExp) =>
    [...calls].reverse().find((c) => match.test(c.path))!;
  /** Path of a public webhook URL (the app is reached through supertest). */
  const pathOf = (url: string) => new URL(url).pathname;

  let twilio: { authToken: string; inboundUrl: string };
  let meta: { inboundUrl: string; verifyToken: string; appSecret: string };
  let telegram: { inboundUrl: string };
  let twilioKey = '';

  beforeAll(async () => {
    providers = await startProviders(calls);
    process.env.TWILIO_API_BASE = providers.base;
    process.env.META_GRAPH_BASE = providers.base;
    process.env.TELEGRAM_API_BASE = providers.base;
    ({ app } = await createApp());
    delivery = app.get(DeliveryService);
    owner = await registerAccount(app, 'channels');
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => providers.server.close(() => r()));
    delete process.env.TWILIO_API_BASE;
    delete process.env.META_GRAPH_BASE;
    delete process.env.TELEGRAM_API_BASE;
  });

  it('connects Twilio, WhatsApp and Telegram with checked, hidden credentials and webhook setup', async () => {
    const tw = (
      await post('/channel-accounts', {
        channel: 'sms',
        provider: 'Twilio',
        name: 'SMS',
        credentials: {
          accountSid: 'AC123',
          authToken: 'tw-secret',
          from: '+14155550100',
        },
      }).expect(201)
    ).body.data;
    expect(tw).toMatchObject({
      status: 'connected',
      identifier: '+14155550100',
    });
    expect(tw.setup.inboundUrl).toMatch(/\/hooks\/twilio\/[\w-]+\/inbound$/);
    expect(JSON.stringify(tw)).not.toMatch(/tw-secret|_credentials/); // hookKey is public (it is in the URL)
    twilio = { authToken: 'tw-secret', inboundUrl: tw.setup.inboundUrl };
    twilioKey = /hooks\/twilio\/([\w-]+)\//.exec(tw.setup.inboundUrl)![1];

    const wa = (
      await post('/channel-accounts', {
        channel: 'whatsapp',
        provider: 'Meta Cloud API',
        name: 'WhatsApp',
        credentials: {
          wabaId: 'WABA1',
          phoneNumberId: 'PN1',
          phoneNumber: '+14155550199',
          accessToken: 'meta-token',
          appSecret: 'meta-app-secret',
        },
      }).expect(201)
    ).body.data;
    expect(wa).toMatchObject({ status: 'connected', quality: 'green' });
    expect(wa.setup.verifyToken).toMatch(/^[0-9a-f]{32}$/);
    meta = {
      inboundUrl: wa.setup.inboundUrl,
      verifyToken: wa.setup.verifyToken,
      appSecret: 'meta-app-secret',
    };

    const tg = (
      await post('/channel-accounts', {
        channel: 'telegram',
        provider: 'Telegram',
        name: 'Bot',
        credentials: { bot: '@acme_bot', botToken: '123:abc' },
      }).expect(201)
    ).body.data;
    expect(tg.status).toBe('connected');
    expect(tg.setup.registered).toBe(false); // needs an HTTPS public URL
    telegram = { inboundUrl: tg.setup.inboundUrl };

    const bad = await post('/channel-accounts', {
      channel: 'whatsapp',
      provider: 'Meta Cloud API',
      credentials: { phoneNumberId: 'PN1', accessToken: 'x' },
    }).expect(422);
    expect(bad.body.code).toBe('CREDENTIALS_MISSING');
  });

  it('SMS campaign: personalised send, signed delivery report, bad numbers fail permanently', async () => {
    const list = (await post('/lists', { name: 'SMS list' }).expect(201)).body
      .data;
    await post('/contacts', {
      firstName: 'Ada',
      phone: '+1 (415) 555-0123',
      listIds: [list.id],
      consents: { sms: 'subscribed' },
    }).expect(201);
    await post('/contacts', {
      firstName: 'Bad',
      phone: '+15550000000',
      listIds: [list.id],
      consents: { sms: 'subscribed' },
    }).expect(201);
    const c = (
      await post('/campaigns', {
        name: 'Flash sale',
        channel: 'sms',
        senderLabel: 'Acme',
        body: 'Hi {{first_name}}, 20% off today. Reply STOP to opt out.',
        audience: { listIds: [list.id], segmentIds: [], excludeListIds: [] },
      }).expect(201)
    ).body.data;
    await post(`/campaigns/${c.id}/launch`).expect(200);
    await delivery.processBatch();

    const sent = calls
      .filter((x) => /Messages\.json$/.test(x.path))
      .map((x) => new URLSearchParams(x.body));
    const ada = sent.find((p) => p.get('Body')?.startsWith('Hi Ada'))!;
    expect(ada.get('From')).toBe('+14155550100');
    expect(ada.get('StatusCallback')).toMatch(
      new RegExp(`/hooks/twilio/${twilioKey}/status$`),
    );

    const msgs = (await get(`/messages?campaignId=${c.id}`).expect(200)).body
      .data.data;
    const ok = msgs.find((m: { status: string }) => m.status === 'sent');
    expect(ok.providerMessageId).toMatch(/^SM/);
    expect(
      msgs.find((m: { errorCode: string }) => m.errorCode === 'TWILIO_21211')
        .status,
    ).toBe('failed');

    // Delivery report: a wrong signature is refused, a correct one moves the message forward.
    const statusUrl = twilio.inboundUrl.replace(/inbound$/, 'status');
    const params = {
      MessageSid: ok.providerMessageId,
      MessageStatus: 'delivered',
    };
    await api()
      .post(pathOf(statusUrl))
      .type('form')
      .set('X-Twilio-Signature', 'forged')
      .send(params)
      .expect(403);
    await api()
      .post(pathOf(statusUrl))
      .type('form')
      .set(
        'X-Twilio-Signature',
        twilioSignature(twilio.authToken, statusUrl, params),
      )
      .send(params)
      .expect(200);
    const after = (await get(`/messages/${ok.id}`).expect(200)).body.data;
    expect(after.status).toBe('delivered');
    expect(
      (await get(`/campaigns/${c.id}`).expect(200)).body.data.stats,
    ).toMatchObject({ sent: 1, failed: 1, delivered: 1 });
  });

  let smsConversation = '';
  it('inbound SMS: creates the contact and conversation, fires "Message received", STOP opts out', async () => {
    const wf = (
      await post('/workflows', {
        name: 'Auto-tag SMS',
        trigger: { type: 'message_received', config: { channel: 'sms' } },
        steps: [{ id: 'tag1', type: 'add_tag', config: { tag: 'texted-us' } }],
      }).expect(201)
    ).body.data;
    await post(`/workflows/${wf.id}/publish`, { note: 'v1' }).expect(200);

    const params = {
      From: '+14155550999',
      To: '+14155550100',
      Body: 'Is the sale still on?',
      MessageSid: 'SMin1',
    };
    await api()
      .post(pathOf(twilio.inboundUrl))
      .type('form')
      .set(
        'X-Twilio-Signature',
        twilioSignature(twilio.authToken, twilio.inboundUrl, params),
      )
      .send(params)
      .expect(200)
      .expect('Content-Type', /xml/);

    const [conv] = (await get('/conversations?channel=sms').expect(200)).body
      .data.data;
    expect(conv).toMatchObject({
      contactHandle: '+14155550999',
      unreadCount: 1,
      lastMessagePreview: 'Is the sale still on?',
    });
    smsConversation = conv.id;
    const contact = (await get(`/contacts/${conv.contactId}`).expect(200)).body
      .data;
    expect(contact).toMatchObject({ phone: '+14155550999', source: 'inbound' });
    expect(contact.tags).toContain('texted-us');

    const stop = {
      From: '+14155550999',
      To: '+14155550100',
      Body: 'STOP',
      MessageSid: 'SMin2',
    };
    await api()
      .post(pathOf(twilio.inboundUrl))
      .type('form')
      .set(
        'X-Twilio-Signature',
        twilioSignature(twilio.authToken, twilio.inboundUrl, stop),
      )
      .send(stop)
      .expect(200);
    expect(
      (await get(`/contacts/${conv.contactId}`).expect(200)).body.data.consents
        .sms,
    ).toBe('unsubscribed');
  });

  it('inbox replies are sent through the channel and their status is tracked', async () => {
    const reply = (
      await post(`/conversations/${smsConversation}/messages`, {
        body: 'Yes, until midnight!',
        kind: 'message',
      }).expect(201)
    ).body.data;
    expect(reply.status).toBe('sending');
    await delivery.processBatch();
    const call = new URLSearchParams(lastCall(/Messages\.json$/).body);
    expect(call.get('To')).toBe('+14155550999');
    expect(call.get('Body')).toBe('Yes, until midnight!'); // a reply goes out even after STOP: it answers the customer
    const thread = (
      await get(`/conversations/${smsConversation}/messages`).expect(200)
    ).body.data;
    const rows = Array.isArray(thread) ? thread : thread.data;
    expect(rows.find((m: { id: string }) => m.id === reply.id).status).toBe(
      'sent',
    );
  });

  it('WhatsApp: template review with Meta, approved template campaign with mapped variables, signed webhooks', async () => {
    const t = (
      await post('/templates', {
        name: 'Order update',
        channel: 'whatsapp',
        category: 'utility',
        language: 'en_US',
        body: 'Hi {{1}}, your order {{2}} has shipped.',
        examples: { '1': 'Olivia', '2': '#10482' },
        variableFields: { '1': 'first_name' },
        whatsapp: {
          headerType: 'none',
          header: '',
          footer: 'Acme',
          buttons: [],
        },
      }).expect(201)
    ).body.data;
    const submitted = (await post(`/templates/${t.id}/submit`).expect(200)).body
      .data;
    expect(submitted).toMatchObject({
      status: 'pending',
      metaName: 'order_update',
    });
    const sub = JSON.parse(lastCall(/message_templates$/).body);
    expect(sub).toMatchObject({
      name: 'order_update',
      category: 'UTILITY',
      language: 'en_US',
    });
    expect(
      sub.components.find((c: { type: string }) => c.type === 'BODY').example
        .body_text[0],
    ).toEqual(['Olivia', '#10482']);

    expect(await delivery.syncWhatsappTemplates()).toBe(1);
    expect((await get(`/templates/${t.id}`).expect(200)).body.data.status).toBe(
      'approved',
    );

    const list = (await post('/lists', { name: 'WA list' }).expect(201)).body
      .data;
    await post('/contacts', {
      firstName: 'Grace',
      phone: '+447700900123',
      listIds: [list.id],
      consents: { whatsapp: 'subscribed' },
    }).expect(201);
    const c = (
      await post('/campaigns', {
        name: 'Shipping',
        channel: 'whatsapp',
        senderLabel: 'Acme',
        templateId: t.id,
        audience: { listIds: [list.id], segmentIds: [], excludeListIds: [] },
      }).expect(201)
    ).body.data;
    await post(`/campaigns/${c.id}/launch`).expect(200);
    await delivery.processBatch();
    const payload = JSON.parse(lastCall(/\/PN1\/messages$/).body);
    expect(payload).toMatchObject({
      to: '447700900123',
      type: 'template',
      template: { name: 'order_update', language: { code: 'en_US' } },
    });
    expect(
      payload.template.components[0].parameters.map(
        (p: { text: string }) => p.text,
      ),
    ).toEqual(['Grace', '#10482']);
    const [msg] = (await get(`/messages?campaignId=${c.id}`).expect(200)).body
      .data.data;
    expect(msg.status).toBe('sent');

    // Meta subscription check.
    const challenge = await api()
      .get(
        `${pathOf(meta.inboundUrl)}?hub.mode=subscribe&hub.verify_token=${meta.verifyToken}&hub.challenge=4242`,
      )
      .expect(200);
    expect(challenge.text).toBe('4242');
    await api()
      .get(
        `${pathOf(meta.inboundUrl)}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      )
      .expect(403);

    // Signed events: a read receipt and an inbound reply.
    const event = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: msg.providerMessageId, status: 'read' }],
                contacts: [
                  { wa_id: '447700900123', profile: { name: 'Grace' } },
                ],
                messages: [
                  {
                    from: '447700900123',
                    id: 'wamid.in1',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Thanks!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(event);
    const sig = `sha256=${createHmac('sha256', meta.appSecret).update(raw).digest('hex')}`;
    await api()
      .post(pathOf(meta.inboundUrl))
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=forged')
      .send(raw)
      .expect(403);
    await api()
      .post(pathOf(meta.inboundUrl))
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(raw)
      .expect(200);

    expect(
      (await get(`/messages/${msg.id}`).expect(200)).body.data.status,
    ).toBe('read');
    expect(
      (await get(`/campaigns/${c.id}`).expect(200)).body.data.stats,
    ).toMatchObject({ delivered: 1, opened: 1 });
    const [conv] = (await get('/conversations?channel=whatsapp').expect(200))
      .body.data.data;
    expect(conv).toMatchObject({
      contactHandle: '+447700900123',
      contactName: 'Grace',
      lastMessagePreview: 'Thanks!',
    });
    expect(Date.parse(conv.windowExpiresAt)).toBeGreaterThan(
      Date.now() + 23 * 3600_000,
    ); // 24-hour window opened

    // A free-form reply inside the window.
    await post(`/conversations/${conv.id}/messages`, {
      body: 'You are welcome!',
      kind: 'message',
    }).expect(201);
    await delivery.processBatch();
    expect(JSON.parse(lastCall(/\/PN1\/messages$/).body)).toMatchObject({
      type: 'text',
      text: { body: 'You are welcome!' },
    });
  });

  it('Telegram: secret-checked updates reach the inbox; replies go to the chat', async () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 5,
        date: Math.floor(Date.now() / 1000),
        text: 'Hello bot',
        chat: { id: 987654 },
        from: { first_name: 'Lin', last_name: 'Wu' },
      },
    };
    await api().post(pathOf(telegram.inboundUrl)).send(update).expect(403); // no secret token
    // The secret is shared only between the server and Telegram (set with setWebhook); read it from storage.
    const [row] = await app
      .get(DataSource)
      .query(
        `SELECT data->>'_credentials' AS c FROM product_records WHERE collection = 'channel-accounts' AND data->>'channel' = 'telegram' AND tenant_id = $1`,
        [owner.tenantId],
      );
    const secret = open<{ webhookSecret: string }>(row.c).webhookSecret;
    await api()
      .post(pathOf(telegram.inboundUrl))
      .set('X-Telegram-Bot-Api-Secret-Token', secret)
      .send(update)
      .expect(200);

    const [conv] = (await get('/conversations?channel=telegram').expect(200))
      .body.data.data;
    expect(conv).toMatchObject({
      contactHandle: '987654',
      contactName: 'Lin Wu',
      lastMessagePreview: 'Hello bot',
    });
    await post(`/conversations/${conv.id}/messages`, {
      body: 'Hi Lin!',
      kind: 'message',
    }).expect(201);
    await delivery.processBatch();
    expect(JSON.parse(lastCall(/sendMessage$/).body)).toEqual({
      chat_id: '987654',
      text: 'Hi Lin!',
    });
  });
});
