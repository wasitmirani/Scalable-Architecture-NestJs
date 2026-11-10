import type { CollectionDef, HookContext } from '../records/collection.types';
import {
  fieldError,
  invalidState,
  type ListQuery,
  type Row,
} from '../records/record-store';
import {
  isRuleGroup,
  matchesSegment,
  type SegmentRuleGroup,
} from './segment-engine';
import { assertContactCapacity } from '../platform/plan-limits';

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const unique = (items: string[]) => [...new Set(items)];

/** Contact fields every row carries, so the UI never meets `undefined`. */
export function contactDefaults(input: Record<string, unknown>) {
  return {
    firstName: '',
    lastName: '',
    email: null,
    phone: null,
    companyId: null,
    companyName: null,
    jobTitle: null,
    country: null,
    city: null,
    lifecycleStage: 'subscriber',
    source: 'manual',
    ownerName: null,
    score: 0,
    blocklisted: false,
    lastActivityAt: null,
    ...input,
    tags: unique(asArray(input.tags)),
    listIds: unique(asArray(input.listIds)),
    consents: { email: 'none', ...((input.consents as object) ?? {}) },
    attributes: { ...((input.attributes as object) ?? {}) },
  };
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fieldError(
      422,
      'INVALID_EMAIL',
      'email',
      'Enter a valid email address',
    );
  }
  return email;
}

async function assertEmailFree(
  ctx: HookContext,
  email: string | null,
  exceptId?: string,
) {
  if (!email) return;
  const [{ count }] = await ctx.store.em.query<{ count: string }[]>(
    `SELECT count(*) FROM product_records
     WHERE tenant_id = $1 AND collection = 'contacts'
       AND lower(data->>'email') = lower($2) AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [ctx.store.tenantId, email, exceptId ?? null],
  );
  if (Number(count) > 0) {
    throw fieldError(
      409,
      'CONTACT_EXISTS',
      'email',
      'A contact with this email already exists.',
    );
  }
}

/** Contacts matching a saved segment's rules (evaluated in the app, like the UI preview). */
export async function contactsInSegment(
  ctx: HookContext,
  rules: SegmentRuleGroup,
) {
  const contacts = await ctx.store.all('contacts');
  return contacts.filter((c) => matchesSegment(c, rules));
}

export const contactsCollection: CollectionDef = {
  path: 'contacts',
  read: 'contacts.read',
  write: 'contacts.manage',
  searchFields: ['firstName', 'lastName', 'email', 'phone', 'companyName'],
  /** `listId`, `tag` and `consent` become JSON containment; `segmentId` is handled by CrmService. */
  prepareList: (_ctx, q: ListQuery) => {
    const { listId, tag, consent, ...filters } = q.filters ?? {};
    const contains = [...(q.contains ?? [])];
    if (listId) contains.push({ listIds: [listId] });
    if (tag) contains.push({ tags: [tag] });
    if (consent) contains.push({ consents: { email: consent } });
    return { ...q, filters, contains };
  },
  beforeCreate: async (ctx, input) => {
    const email = normalizeEmail(input.email);
    await assertEmailFree(ctx, email);
    await assertContactCapacity(ctx, 1);
    return contactDefaults({ ...input, email });
  },
  beforeUpdate: async (ctx, existing, patch) => {
    if ('email' in patch) {
      const email = normalizeEmail(patch.email);
      await assertEmailFree(ctx, email, existing.id);
      patch = { ...patch, email };
    }
    if ('tags' in patch) patch.tags = unique(asArray(patch.tags));
    if ('listIds' in patch) patch.listIds = unique(asArray(patch.listIds));
    return patch;
  },
  beforeDelete: async (ctx, contact) => {
    await ctx.store.removeWhere('activities', { contactId: contact.id });
  },
};

export const listsCollection: CollectionDef = {
  path: 'lists',
  read: 'contacts.read',
  write: 'contacts.manage',
  searchFields: ['name', 'folder'],
  decorate: async (ctx, rows) =>
    Promise.all(
      rows.map(async (list) => ({
        ...list,
        contactCount: await ctx.store.count('contacts', { listIds: [list.id] }),
      })),
    ),
  beforeCreate: (_ctx, input) => {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    return { folder: null, description: '', ...input, name: input.name.trim() };
  },
  /** Contacts keep no dangling list ids. */
  beforeDelete: async (ctx, list) => {
    await ctx.store.em.query(
      `UPDATE product_records
       SET data = jsonb_set(data, '{listIds}', (data->'listIds') - $3::text), updated_at = now()
       WHERE tenant_id = $1 AND collection = 'contacts' AND data @> $2::jsonb`,
      [ctx.store.tenantId, JSON.stringify({ listIds: [list.id] }), list.id],
    );
  },
};

export const segmentsCollection: CollectionDef = {
  path: 'segments',
  read: 'contacts.read',
  write: 'contacts.manage',
  searchFields: ['name', 'description'],
  decorate: async (ctx, rows) => {
    if (!rows.length) return rows;
    const contacts = await ctx.store.all('contacts');
    return rows.map((segment) => ({
      ...segment,
      contactCount: contacts.filter((c) =>
        matchesSegment(c, segment.rules as SegmentRuleGroup),
      ).length,
    }));
  },
  beforeCreate: (_ctx, input) => {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    if (!isRuleGroup(input.rules)) {
      throw fieldError(
        422,
        'INVALID_RULES',
        'rules',
        'Rules must be a group with match and rules',
      );
    }
    return { description: '', ...input };
  },
  beforeUpdate: (_ctx, _existing, patch) => {
    if ('rules' in patch && !isRuleGroup(patch.rules)) {
      throw fieldError(
        422,
        'INVALID_RULES',
        'rules',
        'Rules must be a group with match and rules',
      );
    }
    return patch;
  },
};

const ATTRIBUTE_TYPES = new Set([
  'text',
  'number',
  'date',
  'boolean',
  'select',
]);

export const attributesCollection: CollectionDef = {
  path: 'contact-attributes',
  read: 'contacts.read',
  write: 'contacts.manage',
  searchFields: ['key', 'label'],
  defaultSort: 'createdAt',
  defaults: () => [
    {
      key: 'first_name',
      label: 'First name',
      type: 'text',
      options: [],
      system: true,
    },
    {
      key: 'last_name',
      label: 'Last name',
      type: 'text',
      options: [],
      system: true,
    },
    { key: 'email', label: 'Email', type: 'text', options: [], system: true },
    { key: 'phone', label: 'Phone', type: 'text', options: [], system: true },
    {
      key: 'country',
      label: 'Country',
      type: 'text',
      options: [],
      system: true,
    },
  ],
  beforeCreate: async (ctx, input) => {
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) {
      throw fieldError(
        422,
        'INVALID_KEY',
        'key',
        'Use lowercase letters, numbers and underscores, starting with a letter',
      );
    }
    if (!ATTRIBUTE_TYPES.has(String(input.type))) {
      throw fieldError(422, 'INVALID_TYPE', 'type', 'Pick a supported type');
    }
    if (await ctx.store.count('contact-attributes', { key })) {
      throw fieldError(
        409,
        'ATTRIBUTE_EXISTS',
        'key',
        'An attribute with this key already exists',
      );
    }
    return { options: [], ...input, key, system: false };
  },
  beforeUpdate: (_ctx, existing, patch) => {
    if (existing.system)
      throw invalidState('System attributes cannot be edited.');
    if (
      ('key' in patch && patch.key !== existing.key) ||
      ('type' in patch && patch.type !== existing.type)
    ) {
      throw invalidState(
        'An attribute key and type cannot change after it is created.',
      );
    }
    const rest = { ...patch };
    delete rest.system;
    return rest;
  },
  beforeDelete: (_ctx, existing) => {
    if (existing.system)
      throw invalidState('System attributes cannot be deleted.');
  },
};

export const importsCollection: CollectionDef = {
  path: 'contacts/imports',
  read: 'contacts.read',
  write: 'contacts.import',
  searchFields: ['fileName'],
};

export const activitiesShape = { searchFields: ['title'], defaultSort: 'at' };

/** Rows a hook may treat as typed contacts. */
export type ContactRow = Row & {
  email: string | null;
  phone: string | null;
  tags: string[];
  listIds: string[];
  attributes: Record<string, unknown>;
};
