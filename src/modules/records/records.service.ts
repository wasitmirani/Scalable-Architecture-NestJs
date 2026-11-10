import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ForbiddenException } from '../../common/exceptions/custom.exceptions';
import type { Principal, TenantContext } from '../../common/types/principal';
import { TenantDb } from '../../database/database.module';
import { COLLECTIONS } from './collections.registry';
import { assertFeature, type Feature } from '../platform/plan-limits';
import type { CollectionDef, HookContext } from './collection.types';
import {
  invalid,
  RecordStore,
  type ListQuery,
  type Page,
  type Row,
  type StoreChange,
} from './record-store';

const SEEDED = '_seeded';

/** Resources a plan must include before new rows can be created (see plan-limits.ts). */
const PLAN_GATES: Partial<Record<string, Feature>> = {
  segments: 'segments',
  companies: 'salesCrm',
  deals: 'salesCrm',
  pipelines: 'salesCrm',
  tasks: 'salesCrm',
  calls: 'voice',
  'ivr-menus': 'voice',
};
const MAX_CHANGE_DEPTH = 4;

export type CommitListener = (
  tenantId: string,
  touched: Map<string, Set<string> | null>,
) => Promise<void> | void;

export type ChangeListener = (
  ctx: HookContext,
  changes: StoreChange[],
  depth: number,
) => Promise<void>;

/** Paths sorted longest first, so `contacts/imports` wins over `contacts`. */
const BY_PATH = [...COLLECTIONS].sort((a, b) => b.path.length - a.path.length);

@Injectable()
export class RecordsService {
  private readonly logger = new Logger(RecordsService.name);
  private readonly listeners: ChangeListener[] = [];
  private readonly commitListeners: CommitListener[] = [];

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDb: TenantDb,
  ) {}

  /** `contacts/imports/abc` → { def: contacts/imports, id: 'abc' }. */
  resolve(path: string): { def: CollectionDef; id: string | null } | null {
    const clean = path.replace(/^\/+|\/+$/g, '');
    for (const def of BY_PATH) {
      if (clean === def.path) return { def, id: null };
      if (clean.startsWith(`${def.path}/`)) {
        const rest = clean.slice(def.path.length + 1);
        if (rest && !rest.includes('/')) return { def, id: rest };
      }
    }
    return null;
  }

  def(path: string): CollectionDef {
    const def = COLLECTIONS.find((c) => c.path === path);
    if (!def) throw new Error(`Unknown collection ${path}`);
    return def;
  }

  assertCan(tenant: TenantContext, permission: string | null) {
    if (permission && !tenant.permissions.has(permission)) {
      throw new ForbiddenException(`You need the ${permission} permission`);
    }
  }

  async actorName(principal: Principal): Promise<string> {
    if (principal.type !== 'user') return 'API';
    const [row] = await this.dataSource.query<{ name: string }[]>(
      `SELECT name FROM users WHERE id = $1`,
      [principal.userId],
    );
    return row?.name ?? principal.email;
  }

  /** Permission check + actor lookup + tenant transaction, for module action endpoints. */
  async exec<T>(
    tenant: TenantContext,
    principal: Principal,
    permission: string | null,
    work: (ctx: HookContext) => Promise<T>,
  ): Promise<T> {
    this.assertCan(tenant, permission);
    return this.run(tenant, await this.actorName(principal), work);
  }

  /**
   * Registers a listener for writes to watched collections (contacts, deals).
   * Used by automation triggers; listeners run after the work, in the same transaction.
   */
  onChange(listener: ChangeListener) {
    this.listeners.push(listener);
  }

  /**
   * Registers a listener called after a unit of work commits, with every
   * collection and row it wrote (realtime events). Errors are logged, never thrown.
   */
  onCommit(listener: CommitListener) {
    this.commitListeners.push(listener);
  }

  /** Runs work in one tenant transaction with a store and hook context. */
  async run<T>(
    tenant: TenantContext,
    actorName: string,
    work: (ctx: HookContext) => Promise<T>,
  ): Promise<T> {
    let store: RecordStore | null = null;
    const result = await this.tenantDb.run(tenant.tenantId, async (em) => {
      store = new RecordStore(em, tenant.tenantId);
      const ctx = { store, tenant, actorName };
      const out = await work(ctx);
      await this.drainChanges(ctx);
      return out;
    });
    // Committed: tell realtime listeners what changed (never fails the request).
    const touched = (store as RecordStore | null)?.touched;
    if (touched?.size) {
      for (const listener of this.commitListeners) {
        void Promise.resolve(listener(tenant.tenantId, touched)).catch(
          (error: Error) =>
            this.logger.warn(`Commit listener failed: ${error.message}`),
        );
      }
    }
    return result;
  }

  /**
   * Hands buffered writes to listeners. Listeners may write again (an automation tags
   * a contact, which starts another automation), so this repeats, up to a depth limit
   * that stops loops. Each listener runs in a savepoint: a failing automation is
   * logged and rolled back without undoing the user's own change.
   */
  private async drainChanges(ctx: HookContext) {
    if (!this.listeners.length) {
      ctx.store.changes.length = 0;
      return;
    }
    for (let depth = 0; depth < MAX_CHANGE_DEPTH; depth++) {
      const batch = ctx.store.changes.splice(0);
      if (!batch.length) return;
      for (const listener of this.listeners) {
        await ctx.store.em.query('SAVEPOINT change_listener');
        try {
          await listener(ctx, batch, depth);
          await ctx.store.em.query('RELEASE SAVEPOINT change_listener');
        } catch (error) {
          await ctx.store.em.query('ROLLBACK TO SAVEPOINT change_listener');
          this.logger.error(
            `Change listener failed in workspace ${ctx.tenant.tenantId}: ${(error as Error).message}`,
          );
        }
      }
    }
    const dropped = ctx.store.changes.splice(0).length;
    if (dropped)
      this.logger.warn(
        `Stopped after ${MAX_CHANGE_DEPTH} rounds of chained automation triggers (${dropped} change(s) not processed); check for automations that trigger each other.`,
      );
  }

  /** Inserts a collection's default rows the first time a workspace touches it. */
  async ensureDefaults(ctx: HookContext, def: CollectionDef) {
    if (!def.defaults) return;
    if (await ctx.store.count(SEEDED, { collection: def.path })) return;
    await ctx.store.insertMany(def.path, def.defaults());
    await ctx.store.insert(SEEDED, { collection: def.path });
  }

  /** Computed fields in, private (`_`) fields out: what clients see. */
  async decorate(
    ctx: HookContext,
    def: CollectionDef,
    rows: Row[],
  ): Promise<Row[]> {
    const decorated = def.decorate ? await def.decorate(ctx, rows) : rows;
    return decorated.map(publicRow);
  }

  /** Drops server-owned and private keys from a client body. */
  sanitize(def: CollectionDef, input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalid('Request body must be a JSON object', 'INVALID_BODY');
    }
    const blocked = new Set(def.serverFields ?? []);
    return Object.fromEntries(
      Object.entries(input).filter(
        ([k]) => !k.startsWith('_') && !blocked.has(k),
      ),
    );
  }

  async list(
    ctx: HookContext,
    def: CollectionDef,
    q: ListQuery,
  ): Promise<Page<Row>> {
    await this.ensureDefaults(ctx, def);
    const query = def.prepareList ? await def.prepareList(ctx, q) : q;
    const page = await ctx.store.list(def.path, def, query);
    return { ...page, data: await this.decorate(ctx, def, page.data) };
  }

  async get(ctx: HookContext, def: CollectionDef, id: string) {
    await this.ensureDefaults(ctx, def);
    const row = await ctx.store.find(def.path, id);
    return (await this.decorate(ctx, def, [row]))[0];
  }

  async create(ctx: HookContext, def: CollectionDef, body: unknown) {
    const gate = PLAN_GATES[def.path];
    if (gate) await assertFeature(ctx, gate);
    await this.ensureDefaults(ctx, def);
    const input = this.sanitize(def, body);
    const data = def.beforeCreate ? await def.beforeCreate(ctx, input) : input;
    const row = await ctx.store.insert(def.path, data);
    return (await this.decorate(ctx, def, [row]))[0];
  }

  async update(
    ctx: HookContext,
    def: CollectionDef,
    id: string,
    body: unknown,
  ) {
    const patch = this.sanitize(def, body);
    const existing = await ctx.store.find(def.path, id);
    const data = def.beforeUpdate
      ? await def.beforeUpdate(ctx, existing, patch)
      : patch;
    const row = await ctx.store.patch(def.path, id, data);
    return (await this.decorate(ctx, def, [row]))[0];
  }

  async remove(ctx: HookContext, def: CollectionDef, id: string) {
    const existing = await ctx.store.find(def.path, id);
    if (def.beforeDelete) await def.beforeDelete(ctx, existing);
    await ctx.store.remove(def.path, id);
  }
}

export function publicRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => !k.startsWith('_')),
  ) as Row;
}

/** Reads the contract's list query string into a ListQuery. */
export function parseListQuery(raw: Record<string, unknown>): ListQuery {
  const { page, per_page, search, sort, order, ...rest } = raw;
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'string' && value !== '') filters[key] = value;
  }
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  return {
    page: num(page),
    perPage: num(per_page),
    search: typeof search === 'string' ? search : undefined,
    sort: typeof sort === 'string' && sort ? sort : undefined,
    order: order === 'asc' || order === 'desc' ? order : undefined,
    filters,
  };
}
