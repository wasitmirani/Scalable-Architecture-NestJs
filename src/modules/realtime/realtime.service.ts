import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { dbOptions } from '../../database/typeorm.config';
import { AccessService } from '../access/access.service';
import { RecordsService } from '../records/records.service';

/** Collections outside the standard registry and the permission that may see them. */
const EXTRA_READ: Record<string, string | null> = {
  executions: 'automations.read',
  'conversation-messages': 'inbox.read',
  'billing/subscription': 'billing.read',
};

const CHANNEL = 'linqflow_realtime';

/** A WebSocket frame as text (ws delivers a Buffer, an ArrayBuffer or fragments). */
const decode = (raw: RawData) =>
  (Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw)
  ).toString('utf8');
const AUTH_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;
const SESSION_RECHECK_MS = 5 * 60_000;
const MAX_NOTIFY_BYTES = 7_500; // Postgres NOTIFY payloads are limited to 8000 bytes

export interface ChangeEvent {
  collection: string;
  /** Changed row ids, or null when many / unknown rows changed. */
  ids: string[] | null;
}

interface Client_ {
  socket: WebSocket;
  tenantId: string;
  userId: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
  alive: boolean;
}

/**
 * Realtime updates over WebSocket (`/realtime`).
 *
 * - The browser connects with the native WebSocket and sends
 *   `{ type: 'auth', token, tenantId }` first (tokens never go in URLs or logs).
 *   The token and workspace membership are checked like an HTTP request.
 * - After every committed write, the changed collections and row ids are sent to
 *   the workspace's sockets whose role can read that collection. Events carry no
 *   row data: clients refetch through the API, so permissions stay in one place.
 * - Fan-out across API instances uses Postgres LISTEN/NOTIFY (no extra service).
 * - Sockets are pinged every 30 s and sessions re-checked every 5 minutes, so a
 *   logout or revoked session also ends the realtime connection.
 */
@Injectable()
export class RealtimeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeService.name);
  private wss: WebSocketServer | null = null;
  private listener: Client | null = null;
  private readonly clients = new Set<Client_>();
  private timers: NodeJS.Timeout[] = [];
  private onUpgrade?: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  private server?: Server;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    private readonly access: AccessService,
    private readonly records: RecordsService,
  ) {}

  async onApplicationBootstrap() {
    this.records.onCommit((tenantId, touched) =>
      this.publish(tenantId, touched),
    );
    if (process.env.REALTIME === 'off') return;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.wss.on('connection', (socket: WebSocket) => this.accept(socket));
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.onUpgrade = (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/realtime') return; // other upgrade handlers may exist
      if (!this.originAllowed(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) =>
        this.wss!.emit('connection', ws, req),
      );
    };
    this.server.on('upgrade', this.onUpgrade);

    await this.listen();
    this.timers.push(setInterval(() => this.heartbeat(), PING_MS));
    this.timers.push(
      setInterval(() => void this.recheckSessions(), SESSION_RECHECK_MS),
    );
    for (const t of this.timers) t.unref();
  }

  async onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
    if (this.server && this.onUpgrade)
      this.server.off('upgrade', this.onUpgrade);
    for (const c of this.clients) c.socket.terminate();
    this.clients.clear();
    this.wss?.close();
    await this.listener?.end().catch(() => undefined);
  }

  /** Number of authenticated sockets (health checks and tests). */
  get connections() {
    return this.clients.size;
  }

  private originAllowed(origin: string | undefined) {
    if (!origin) return true; // non-browser clients
    const allowed = (
      process.env.ALLOWED_ORIGINS ??
      process.env.FRONTEND_URL ??
      ''
    )
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    return allowed.length === 0 || allowed.includes(origin);
  }

  // ---------- Fan-out ----------

  /** A dedicated connection receives NOTIFY from every API instance. */
  private async listen() {
    const o = dbOptions as {
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      database?: string;
    };
    const client = new Client({
      host: o.host,
      port: o.port,
      user: o.username,
      password: o.password,
      database: o.database,
    });
    client.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      try {
        const { t, e } = JSON.parse(n.payload) as {
          t: string;
          e: ChangeEvent[];
        };
        this.deliver(t, e);
      } catch {
        /* malformed payload: ignore */
      }
    });
    client.on('error', (err) => {
      this.logger.warn(
        `Realtime listener lost its connection: ${err.message}; reconnecting`,
      );
      this.listener = null;
      setTimeout(
        () => void this.listen().catch(() => undefined),
        2_000,
      ).unref();
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.listener = client;
  }

  /** Called after a unit of work commits: tells every instance what changed. */
  async publish(tenantId: string, touched: Map<string, Set<string> | null>) {
    if (!touched.size) return;
    let events: ChangeEvent[] = [...touched].map(([collection, ids]) => ({
      collection,
      ids: ids ? [...ids] : null,
    }));
    let payload = JSON.stringify({ t: tenantId, e: events });
    if (payload.length > MAX_NOTIFY_BYTES) {
      // Too many ids: send collection names only (clients refetch the lists).
      events = events.map((e) => ({ collection: e.collection, ids: null }));
      payload = JSON.stringify({ t: tenantId, e: events });
    }
    try {
      await this.dataSource.query(`SELECT pg_notify($1, $2)`, [
        CHANNEL,
        payload,
      ]);
    } catch (error) {
      this.logger.warn(`Realtime publish failed: ${(error as Error).message}`);
    }
  }

  /** Sends events to this instance's sockets in the workspace that may read them. */
  private deliver(tenantId: string, events: ChangeEvent[]) {
    for (const c of this.clients) {
      if (c.tenantId !== tenantId || c.socket.readyState !== WebSocket.OPEN)
        continue;
      const visible = events.filter((e) => this.canRead(c, e.collection));
      if (visible.length)
        c.socket.send(JSON.stringify({ type: 'changes', events: visible }));
    }
  }

  private canRead(c: Client_, collection: string) {
    // Via RecordsService: importing the registry here would create an import cycle.
    const found = this.records.resolve(collection);
    const def = found && found.id === null ? found.def : undefined;
    const permission = def ? def.read : EXTRA_READ[collection];
    if (permission === undefined) return false; // unknown or private collection
    return permission === null || c.permissions.has(permission);
  }

  // ---------- Connections ----------

  private accept(socket: WebSocket) {
    const timeout = setTimeout(
      () => socket.close(4401, 'Authenticate within 10 seconds'),
      AUTH_TIMEOUT_MS,
    );
    let client: Client_ | null = null;
    socket.on('message', (raw: RawData) => {
      void (async () => {
        let msg: { type?: string; token?: string; tenantId?: string };
        try {
          msg = JSON.parse(decode(raw)) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === 'ping')
          return socket.send(JSON.stringify({ type: 'pong' }));
        if (msg.type !== 'auth' || client) return;
        clearTimeout(timeout);
        try {
          client = await this.authenticate(
            socket,
            msg.token ?? '',
            msg.tenantId ?? '',
          );
          this.clients.add(client);
          socket.send(JSON.stringify({ type: 'ready' }));
        } catch (error) {
          socket.close(4401, (error as Error).message.slice(0, 120));
        }
      })();
    });
    socket.on('pong', () => {
      if (client) client.alive = true;
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (client) this.clients.delete(client);
    });
    socket.on('error', () => socket.terminate());
  }

  private async sessionValid(userId: string, sessionId: string) {
    const [row] = await this.dataSource.query<{ status: string }[]>(
      `SELECT u.status FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND u.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sessionId, userId],
    );
    return row?.status === 'active';
  }

  private async authenticate(
    socket: WebSocket,
    token: string,
    tenantId: string,
  ): Promise<Client_> {
    let payload: { sub: string; sid: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
    } catch {
      throw new Error('Invalid or expired access token');
    }
    if (
      payload.typ !== 'access' ||
      !(await this.sessionValid(payload.sub, payload.sid))
    )
      throw new Error('Session has ended');
    const tenant = await this.access.resolveTenantContext(
      {
        type: 'user',
        userId: payload.sub,
        sessionId: payload.sid,
        email: '',
        isPlatformAdmin: false,
      },
      tenantId,
    );
    return {
      socket,
      tenantId: tenant.tenantId,
      userId: payload.sub,
      sessionId: payload.sid,
      permissions: tenant.permissions,
      alive: true,
    };
  }

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }

  /**
   * Logged-out or revoked sessions lose their realtime connection, and role
   * changes or removal from the workspace take effect without reconnecting.
   */
  private async recheckSessions() {
    for (const c of this.clients) {
      try {
        if (!(await this.sessionValid(c.userId, c.sessionId))) {
          c.socket.close(4401, 'Session has ended');
          continue;
        }
        const tenant = await this.access.resolveTenantContext(
          {
            type: 'user',
            userId: c.userId,
            sessionId: c.sessionId,
            email: '',
            isPlatformAdmin: false,
          },
          c.tenantId,
        );
        c.permissions = tenant.permissions;
      } catch {
        c.socket.close(4403, 'No longer a member of this workspace');
      }
    }
  }
}
