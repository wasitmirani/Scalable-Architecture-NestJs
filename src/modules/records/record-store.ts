import { HttpException, HttpStatus } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { NotFoundException } from '../../common/exceptions/custom.exceptions';

/** A product row as the API returns it: stored fields plus id and timestamps. */
export type Row = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export interface ListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  /** Equality filters; an array field matches when it contains the value. */
  filters?: Record<string, string>;
  /** JSON containment conditions (`data @> …`), e.g. `{ listIds: [id] }`. */
  contains?: Record<string, unknown>[];
}

export interface Page<T> {
  data: T[];
  current_page: number;
  last_page: number;
  from: number | null;
  to: number | null;
  total: number;
}

export interface CollectionShape {
  searchFields: string[];
  /** Default sort field; newest first. */
  defaultSort?: string;
}

interface DbRow {
  id: string;
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** Field names go into SQL only as bound parameters, but are still restricted to plain keys. */
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COLUMN_SORTS: Record<string, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};
const MAX_PER_PAGE = 200;

export function assertField(name: string): string {
  if (!FIELD.test(name)) throw invalid(`Unknown field "${name}"`);
  return name;
}

export function invalid(message: string, code = 'INVALID_QUERY') {
  return new HttpException(
    { message, error: 'Bad Request', code },
    HttpStatus.BAD_REQUEST,
  );
}

/** 409 for an action the row's current state does not allow (contract: INVALID_STATE). */
export function invalidState(message: string) {
  return new HttpException(
    { message, error: 'Conflict', code: 'INVALID_STATE' },
    HttpStatus.CONFLICT,
  );
}

/** 409/422 with inline field errors so forms can show them next to the input. */
export function fieldError(
  status: 409 | 422,
  code: string,
  field: string,
  message: string,
) {
  return new HttpException(
    {
      message,
      error: status === 409 ? 'Conflict' : 'Unprocessable Entity',
      code,
      details: [{ field, errors: [message] }],
    },
    status,
  );
}

/** Server-owned keys never accepted from clients. */
const RESERVED = new Set(['id', 'createdAt', 'updatedAt', 'tenantId']);

export function clean(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!RESERVED.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * TypeORM's postgres driver returns `[rows, affected]` for UPDATE/DELETE … RETURNING
 * but plain rows for SELECT/INSERT; this always gives the rows.
 */
function returned<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return result as T[];
}

function toRow(r: DbRow): Row {
  return {
    ...r.data,
    id: r.id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Collections whose writes are reported to change listeners (automation triggers). */
export const WATCHED_COLLECTIONS = new Set(['contacts', 'deals']);

/** One write to a watched collection: `before` is null for inserts. */
export interface StoreChange {
  collection: string;
  before: Row | null;
  after: Row;
}

/**
 * Data access for product collections inside one tenant transaction (see TenantDb.run).
 * Every query also filters by tenant_id; RLS is the second line of defence.
 */
export class RecordStore {
  /** Writes to watched collections, drained by RecordsService at the end of the unit of work. */
  readonly changes: StoreChange[] = [];

  constructor(
    readonly em: EntityManager,
    readonly tenantId: string,
  ) {}

  private track(collection: string, before: Row | null, after: Row) {
    if (WATCHED_COLLECTIONS.has(collection))
      this.changes.push({ collection, before, after });
  }

  /** UPDATE that also returns the row as it was before (watched collections only). */
  private async update(
    collection: string,
    id: string,
    setSql: string,
    payload: Record<string, unknown>,
  ): Promise<{ row: DbRow; before: Row | null } | null> {
    if (!WATCHED_COLLECTIONS.has(collection)) {
      const [row] = returned<DbRow>(
        await this.em.query(
          `UPDATE product_records SET data = ${setSql}, updated_at = now()
         WHERE tenant_id = $1 AND collection = $2 AND id = $3
         RETURNING id, data, created_at, updated_at`,
          [this.tenantId, collection, id, JSON.stringify(clean(payload))],
        ),
      );
      return row ? { row, before: null } : null;
    }
    // The CTE reads the snapshot from before this statement, so `before` is the old row.
    const [row] = returned<DbRow & { before: Record<string, unknown> }>(
      await this.em.query(
        `WITH prev AS (
           SELECT id, data, created_at, updated_at FROM product_records
           WHERE tenant_id = $1 AND collection = $2 AND id = $3
         )
         UPDATE product_records p SET data = ${setSql.replace(/\bdata\b/g, 'p.data')}, updated_at = now()
         FROM prev WHERE p.id = prev.id
         RETURNING p.id, p.data, p.created_at, p.updated_at, prev.data AS before, prev.updated_at AS before_updated_at`,
        [this.tenantId, collection, id, JSON.stringify(clean(payload))],
      ),
    );
    if (!row) return null;
    const before = toRow({
      id: row.id,
      data: row.before,
      created_at: row.created_at,
      updated_at: (row as unknown as { before_updated_at: Date })
        .before_updated_at,
    });
    return { row, before };
  }

  async list<T extends Row = Row>(
    collection: string,
    shape: CollectionShape,
    q: ListQuery = {},
  ): Promise<Page<T>> {
    const params: unknown[] = [this.tenantId, collection];
    const where = ['tenant_id = $1', 'collection = $2'];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const search = q.search?.trim();
    if (search && shape.searchFields.length) {
      const pattern = p(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(
        `(${shape.searchFields.map((f) => `coalesce(data->>${p(f)}, '') ILIKE ${pattern}`).join(' OR ')})`,
      );
    }
    for (const [key, value] of Object.entries(q.filters ?? {})) {
      if (value === undefined || value === '') continue;
      assertField(key);
      const k = p(key);
      const v = p(String(value));
      where.push(
        `(data->>${k} = ${v} OR (jsonb_typeof(data->${k}) = 'array' AND data->${k} ? ${v}))`,
      );
    }

    for (const condition of q.contains ?? []) {
      where.push(`data @> ${p(JSON.stringify(condition))}::jsonb`);
    }

    const whereSql = where.join(' AND ');
    const [{ count }] = await this.em.query<{ count: string }[]>(
      `SELECT count(*) FROM product_records WHERE ${whereSql}`,
      params,
    );
    const total = Number(count);
    const perPage = Math.min(Math.max(1, q.perPage ?? 20), MAX_PER_PAGE);
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(Math.max(1, q.page ?? 1), lastPage);

    const sort = q.sort ?? shape.defaultSort ?? 'createdAt';
    const order =
      (q.order ?? (q.sort ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
    let orderSql: string;
    if (COLUMN_SORTS[sort]) {
      orderSql = `${COLUMN_SORTS[sort]} ${order}`;
    } else {
      const s = p(assertField(sort));
      // Strings sort case-insensitively, numbers numerically; missing values last.
      orderSql = `CASE WHEN jsonb_typeof(data->${s}) = 'string' THEN lower(data->>${s}) END ${order} NULLS LAST, data->${s} ${order} NULLS LAST`;
    }

    const rows = await this.em.query<DbRow[]>(
      `SELECT id, data, created_at, updated_at FROM product_records
       WHERE ${whereSql} ORDER BY ${orderSql}, created_at DESC, id
       LIMIT ${p(perPage)} OFFSET ${p((page - 1) * perPage)}`,
      params,
    );
    const start = (page - 1) * perPage;
    return {
      data: rows.map(toRow) as T[],
      current_page: page,
      last_page: lastPage,
      from: rows.length ? start + 1 : null,
      to: rows.length ? start + rows.length : null,
      total,
    };
  }

  /** Every row of a collection (derived data: counts, engines). Newest first. */
  async all<T extends Row = Row>(
    collection: string,
    where: Record<string, unknown> = {},
  ): Promise<T[]> {
    const rows = await this.em.query<DbRow[]>(
      `SELECT id, data, created_at, updated_at FROM product_records
       WHERE tenant_id = $1 AND collection = $2 AND data @> $3::jsonb
       ORDER BY created_at DESC, id`,
      [this.tenantId, collection, JSON.stringify(where)],
    );
    return rows.map(toRow) as T[];
  }

  /** Rows whose JSON contains `where` (jsonb containment, uses the GIN index). */
  async count(collection: string, where: Record<string, unknown> = {}) {
    const [{ count }] = await this.em.query<{ count: string }[]>(
      `SELECT count(*) FROM product_records
       WHERE tenant_id = $1 AND collection = $2 AND data @> $3::jsonb`,
      [this.tenantId, collection, JSON.stringify(where)],
    );
    return Number(count);
  }

  async findOrNull<T extends Row = Row>(
    collection: string,
    id: string,
  ): Promise<T | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.em.query<DbRow[]>(
      `SELECT id, data, created_at, updated_at FROM product_records
       WHERE tenant_id = $1 AND collection = $2 AND id = $3`,
      [this.tenantId, collection, id],
    );
    return row ? (toRow(row) as T) : null;
  }

  async find<T extends Row = Row>(collection: string, id: string): Promise<T> {
    const row = await this.findOrNull<T>(collection, id);
    if (!row) throw new NotFoundException(label(collection));
    return row;
  }

  async insert<T extends Row = Row>(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    const [row] = await this.em.query<DbRow[]>(
      `INSERT INTO product_records (tenant_id, collection, data)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, data, created_at, updated_at`,
      [this.tenantId, collection, JSON.stringify(clean(data))],
    );
    const created = toRow(row);
    this.track(collection, null, created);
    return created as T;
  }

  async insertMany(collection: string, items: Record<string, unknown>[]) {
    if (!items.length) return [];
    const rows = await this.em.query<DbRow[]>(
      `INSERT INTO product_records (tenant_id, collection, data)
       SELECT $1, $2, value FROM jsonb_array_elements($3::jsonb)
       RETURNING id, data, created_at, updated_at`,
      [this.tenantId, collection, JSON.stringify(items.map(clean))],
    );
    const created = rows.map(toRow);
    for (const r of created) this.track(collection, null, r);
    return created;
  }

  /** Shallow merge, like the mock's `{ ...existing, ...patch }`. */
  async patch<T extends Row = Row>(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.update(collection, id, 'data || $4::jsonb', patch);
    if (!res) throw new NotFoundException(label(collection));
    const after = toRow(res.row);
    if (res.before) this.track(collection, res.before, after);
    return after as T;
  }

  /** Writes the full data object (used when a handler rebuilt the row). */
  async replace<T extends Row = Row>(collection: string, row: Row): Promise<T> {
    const res = await this.update(collection, row.id, '$4::jsonb', row);
    if (!res) throw new NotFoundException(label(collection));
    const after = toRow(res.row);
    if (res.before) this.track(collection, res.before, after);
    return after as T;
  }

  async remove(collection: string, id: string): Promise<void> {
    const rows = returned<{ id: string }>(
      await this.em.query(
        `DELETE FROM product_records WHERE tenant_id = $1 AND collection = $2 AND id = $3 RETURNING id`,
        [this.tenantId, collection, id],
      ),
    );
    if (!rows.length) throw new NotFoundException(label(collection));
  }

  async removeMany(collection: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const rows = returned<{ id: string }>(
      await this.em.query(
        `DELETE FROM product_records
       WHERE tenant_id = $1 AND collection = $2 AND id::text = ANY($3::text[]) RETURNING id`,
        [this.tenantId, collection, ids],
      ),
    );
    return rows.length;
  }

  /** Deletes rows whose JSON contains `where` (e.g. a contact's activities). */
  async removeWhere(collection: string, where: Record<string, unknown>) {
    await this.em.query(
      `DELETE FROM product_records WHERE tenant_id = $1 AND collection = $2 AND data @> $3::jsonb`,
      [this.tenantId, collection, JSON.stringify(where)],
    );
  }
}

/** "contact-attributes" → "Contact attribute" for 404 messages. */
function label(collection: string) {
  const last = collection.split('/').pop() ?? collection;
  const words = last.replace(/-/g, ' ').replace(/ies$/, 'y').replace(/s$/, '');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Offset page over rows already in memory (segment-filtered lists). */
export function paginate<T>(rows: T[], page = 1, perPage = 20): Page<T> {
  const size = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
  const total = rows.length;
  const lastPage = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), lastPage);
  const start = (current - 1) * size;
  const data = rows.slice(start, start + size);
  return {
    data,
    current_page: current,
    last_page: lastPage,
    from: data.length ? start + 1 : null,
    to: data.length ? start + data.length : null,
    total,
  };
}

/** A string field from client JSON; anything else counts as empty. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
