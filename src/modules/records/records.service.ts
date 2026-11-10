import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ForbiddenException } from '../../common/exceptions/custom.exceptions';
import type { Principal, TenantContext } from '../../common/types/principal';
import { TenantDb } from '../../database/database.module';
import { COLLECTIONS } from './collections.registry';
import type { CollectionDef, HookContext } from './collection.types';
import {
  invalid,
  RecordStore,
  type ListQuery,
  type Page,
  type Row,
} from './record-store';

const SEEDED = '_seeded';

/** Paths sorted longest first, so `contacts/imports` wins over `contacts`. */
const BY_PATH = [...COLLECTIONS].sort((a, b) => b.path.length - a.path.length);

@Injectable()
export class RecordsService {
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

  /** Runs work in one tenant transaction with a store and hook context. */
  run<T>(
    tenant: TenantContext,
    actorName: string,
    work: (ctx: HookContext) => Promise<T>,
  ): Promise<T> {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      work({ store: new RecordStore(em, tenant.tenantId), tenant, actorName }),
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
