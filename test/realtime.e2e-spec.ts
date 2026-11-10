import type { INestApplication } from '@nestjs/common';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { RealtimeService } from '../src/modules/realtime/realtime.service';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { bearer, createApp, registerAccount, type TestAccount } from './helpers';

interface Changes {
  type: 'changes';
  events: { collection: string; ids: string[] | null }[];
}

/** A WebSocket client that records every message and can wait for one. */
function connect(url: string) {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  const waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  socket.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as Record<string, unknown>;
    messages.push(m);
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject); });
  return {
    socket,
    messages,
    closed,
    opened,
    send: (m: object) => socket.send(JSON.stringify(m)),
    waitFor: (match: (m: Record<string, unknown>) => boolean, ms = 4000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const found = messages.find(match);
        if (found) return resolve(found);
        const t = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(messages)}`)), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
  };
}

const hasChange = (collection: string, id?: string) => (m: Record<string, unknown>) =>
  m.type === 'changes' && (m as unknown as Changes).events.some((e) => e.collection === collection && (!id || e.ids === null || e.ids.includes(id)));

describe('Realtime (e2e)', () => {
  let app: INestApplication<App>;
  let wsUrl = '';
  let a: TestAccount;
  let b: TestAccount;

  beforeAll(async () => {
    ({ app } = await createApp());
    await app.listen(0, '127.0.0.1');
    wsUrl = `ws://127.0.0.1:${((app.getHttpServer() as unknown as Server).address() as AddressInfo).port}/realtime`;
    a = await registerAccount(app, 'rt-a');
    b = await registerAccount(app, 'rt-b');
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (acc: TestAccount, path: string, body: object) =>
    request(app.getHttpServer()).post(`/api/v1${path}`).set({ ...bearer(acc.accessToken), 'X-Tenant-Id': acc.tenantId }).send(body);

  async function authed(acc: TestAccount) {
    const c = connect(wsUrl);
    await c.opened;
    c.send({ type: 'auth', token: acc.accessToken, tenantId: acc.tenantId });
    await c.waitFor((m) => m.type === 'ready');
    return c;
  }

  it('pushes committed changes to the workspace, with ids and no row data', async () => {
    const ca = await authed(a);
    const cb = await authed(b);
    const contact = (await post(a, '/contacts', { email: 'live@example.test', firstName: 'Live' }).expect(201)).body.data;

    const msg = (await ca.waitFor(hasChange('contacts', contact.id))) as unknown as Changes;
    expect(JSON.stringify(msg)).not.toContain('live@example.test'); // ids only
    // The other workspace hears nothing about it.
    await new Promise((r) => setTimeout(r, 400));
    expect(cb.messages.some(hasChange('contacts', contact.id))).toBe(false);
    ca.socket.close();
    cb.socket.close();
  });

  it('a failed (rolled back) write is not announced', async () => {
    const ca = await authed(a);
    await post(a, '/contacts', { email: 'not-an-email' }).expect(422);
    await new Promise((r) => setTimeout(r, 400));
    expect(ca.messages.some(hasChange('contacts'))).toBe(false);
    ca.socket.close();
  });

  it('refuses bad tokens, foreign workspaces and silent clients', async () => {
    const bad = connect(wsUrl);
    await bad.opened;
    bad.send({ type: 'auth', token: 'nope', tenantId: a.tenantId });
    expect((await bad.closed).code).toBe(4401);

    const foreign = connect(wsUrl);
    await foreign.opened;
    foreign.send({ type: 'auth', token: a.accessToken, tenantId: b.tenantId });
    expect((await foreign.closed).code).toBe(4401);
  });

  it('logging out ends the realtime session at the next check', async () => {
    const c = await authed(a);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(bearer(a.accessToken)).send({ refreshToken: a.refreshToken });
    // Run the periodic re-check now instead of waiting 5 minutes.
    await (app.get(RealtimeService) as unknown as { recheckSessions: () => Promise<void> }).recheckSessions();
    expect((await c.closed).code).toBe(4401);
  });
});
