import type { TenantContext } from '../../common/types/principal';
import type {
  CollectionShape,
  ListQuery,
  RecordStore,
  Row,
} from './record-store';

/** A hook may answer synchronously or with a promise. */
export type Awaitable<T> = T | Promise<T>;

export interface HookContext {
  store: RecordStore;
  tenant: TenantContext;
  /** Display name of the acting user or API key, for authored rows. */
  actorName: string;
}

/**
 * One standard REST resource from docs/API-CONTRACT.md, served from product_records.
 * `path` is both the URL (`/contacts`) and the collection key.
 */
export interface CollectionDef extends CollectionShape {
  path: string;
  /** Permission for GET; `null` means any workspace member. */
  read: string | null;
  /** Permission for POST/PATCH/DELETE; `null` means any workspace member. */
  write: string | null;
  /** Adds computed fields (counts, joins) to rows sent to clients. */
  decorate?: (ctx: HookContext, rows: Row[]) => Awaitable<Row[]>;
  /** Translates contract-specific list filters into store conditions. */
  prepareList?: (ctx: HookContext, q: ListQuery) => Awaitable<ListQuery>;
  /** Validates and normalizes input; may throw field errors. */
  beforeCreate?: (
    ctx: HookContext,
    input: Record<string, unknown>,
  ) => Awaitable<Record<string, unknown>>;
  beforeUpdate?: (
    ctx: HookContext,
    existing: Row,
    patch: Record<string, unknown>,
  ) => Awaitable<Record<string, unknown>>;
  /** Cleans up references before the row is deleted; may refuse with a 409. */
  beforeDelete?: (ctx: HookContext, existing: Row) => Awaitable<void>;
  /** Rows every new workspace starts with (system attributes, default pipeline…). */
  defaults?: () => Record<string, unknown>[];
  /**
   * Fields only the server changes (state machines, computed stats). Dropped from
   * client POST/PATCH bodies; the dedicated action endpoints set them.
   * Keys starting with `_` are always private: never accepted and never returned.
   */
  serverFields?: string[];
}
