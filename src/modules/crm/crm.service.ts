import { Injectable } from '@nestjs/common';
import type { HookContext } from '../records/collection.types';
import {
  fieldError,
  invalid,
  paginate,
  type ListQuery,
  type Row,
} from '../records/record-store';
import { RecordsService } from '../records/records.service';
import {
  contactCapacity,
  planName,
  entitlementsOf,
} from '../platform/plan-limits';
import {
  activitiesShape,
  contactDefaults,
  contactsCollection,
  type ContactRow,
} from './crm.collections';
import {
  isRuleGroup,
  matchesSegment,
  type SegmentRuleGroup,
} from './segment-engine';

const MAX_IMPORT_ROWS = 50_000;
const MAX_BULK_IDS = 10_000;
const MAX_EXPORT_ROWS = 100_000;

export interface BulkUpdateBody {
  ids: string[];
  addTags?: string[];
  removeTags?: string[];
  addListIds?: string[];
  removeListIds?: string[];
  blocklisted?: boolean;
}

export interface ImportBody {
  fileName: string;
  rows: Record<string, string>[];
  mapping: Record<string, string>;
  listId: string | null;
  updateExisting: boolean;
}

const strings = (v: unknown, field: string, max = MAX_BULK_IDS): string[] => {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    v.some((x) => typeof x !== 'string') ||
    v.length > max
  ) {
    throw fieldError(
      422,
      'INVALID_LIST',
      field,
      `${field} must be a list of up to ${max} strings`,
    );
  }
  return v as string[];
};

@Injectable()
export class CrmService {
  constructor(private readonly records: RecordsService) {}

  /** The contacts list, plus `segmentId` which needs the rule engine. */
  async listContacts(ctx: HookContext, q: ListQuery) {
    const { segmentId, ...filters } = q.filters ?? {};
    const prepared = await contactsCollection.prepareList!(ctx, {
      ...q,
      filters,
    });
    if (!segmentId) {
      return this.records.list(ctx, contactsCollection, prepared);
    }
    const rows = await this.matchingContacts(ctx, prepared, segmentId);
    return paginate(rows, q.page, q.perPage);
  }

  /** Every contact matching the list query (and segment), in list order. */
  async matchingContacts(
    ctx: HookContext,
    q: ListQuery,
    segmentId?: string,
  ): Promise<Row[]> {
    // Pages are capped at 200 rows, so read them all in order.
    const all = await ctx.store.list('contacts', contactsCollection, {
      ...q,
      page: 1,
      perPage: 200,
    });
    let rows = all.data;
    for (let page = 2; page <= all.last_page; page++) {
      rows = rows.concat(
        (
          await ctx.store.list('contacts', contactsCollection, {
            ...q,
            page,
            perPage: 200,
          })
        ).data,
      );
    }
    if (!segmentId) return rows;
    const segment = await ctx.store.find('segments', segmentId);
    return rows.filter((c) =>
      matchesSegment(c, segment.rules as SegmentRuleGroup),
    );
  }

  async exportContacts(ctx: HookContext, q: ListQuery) {
    const { segmentId, ...filters } = q.filters ?? {};
    const prepared = await contactsCollection.prepareList!(ctx, {
      ...q,
      filters,
    });
    const rows = await this.matchingContacts(ctx, prepared, segmentId);
    if (rows.length > MAX_EXPORT_ROWS) {
      throw invalid(
        `Exports are limited to ${MAX_EXPORT_ROWS} contacts; narrow the filters.`,
        'EXPORT_TOO_LARGE',
      );
    }
    return rows;
  }

  async bulkUpdate(ctx: HookContext, body: BulkUpdateBody) {
    const ids = strings(body?.ids, 'ids');
    const addTags = strings(body.addTags, 'addTags', 100);
    const removeTags = new Set(strings(body.removeTags, 'removeTags', 100));
    const addListIds = strings(body.addListIds, 'addListIds', 100);
    const removeListIds = new Set(
      strings(body.removeListIds, 'removeListIds', 100),
    );
    if (
      body.blocklisted !== undefined &&
      typeof body.blocklisted !== 'boolean'
    ) {
      throw fieldError(
        422,
        'INVALID_VALUE',
        'blocklisted',
        'blocklisted must be true or false',
      );
    }
    const contacts = await this.findMany<ContactRow>(ctx, ids);
    for (const c of contacts) {
      await ctx.store.replace('contacts', {
        ...c,
        tags: [...new Set([...(c.tags ?? []), ...addTags])].filter(
          (t) => !removeTags.has(t),
        ),
        listIds: [...new Set([...(c.listIds ?? []), ...addListIds])].filter(
          (l) => !removeListIds.has(l),
        ),
        blocklisted: body.blocklisted ?? c.blocklisted,
      });
    }
    return { updated: contacts.length };
  }

  async bulkDelete(ctx: HookContext, body: { ids: string[] }) {
    const ids = strings(body?.ids, 'ids');
    for (const id of ids)
      await ctx.store.removeWhere('activities', { contactId: id });
    return { deleted: await ctx.store.removeMany('contacts', ids) };
  }

  async import(ctx: HookContext, body: ImportBody) {
    if (
      !body ||
      typeof body.fileName !== 'string' ||
      !Array.isArray(body.rows)
    ) {
      throw invalid('Send fileName, rows and mapping', 'INVALID_IMPORT');
    }
    if (body.rows.length > MAX_IMPORT_ROWS) {
      throw invalid(
        `Imports are limited to ${MAX_IMPORT_ROWS} rows per file.`,
        'IMPORT_TOO_LARGE',
      );
    }
    const mapping =
      body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
    if (body.listId) await ctx.store.find('lists', body.listId);

    const existing = await ctx.store.all<ContactRow>('contacts');
    const byEmail = new Map(
      existing
        .filter((c) => c.email)
        .map((c) => [String(c.email).toLowerCase(), c]),
    );
    const toCreate: Record<string, unknown>[] = [];
    const queued = new Set<string>();
    let updated = 0;
    let skipped = 0;

    for (const raw of body.rows) {
      const mapped: Record<string, string> = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (field) mapped[field] = String(raw?.[header] ?? '').trim();
      }
      const email = mapped.email?.toLowerCase() || null;
      if (
        (!email && !mapped.phone) ||
        (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      ) {
        skipped++;
        continue;
      }
      const attributes = Object.fromEntries(
        Object.entries(mapped)
          .filter(([k]) => k.startsWith('attributes.'))
          .map(([k, v]) => [k.slice(11), v]),
      );
      const match = email ? byEmail.get(email) : undefined;
      if (match) {
        if (!body.updateExisting) {
          skipped++;
          continue;
        }
        const merged = await ctx.store.replace<ContactRow>('contacts', {
          ...match,
          firstName: mapped.firstName || match.firstName,
          lastName: mapped.lastName || match.lastName,
          phone: mapped.phone || match.phone,
          listIds: body.listId
            ? [...new Set([...match.listIds, body.listId])]
            : match.listIds,
          attributes: { ...match.attributes, ...attributes },
        });
        byEmail.set(email!, merged);
        updated++;
        continue;
      }
      if (email && queued.has(email)) {
        skipped++; // duplicate row inside the same file
        continue;
      }
      if (email) queued.add(email);
      toCreate.push(
        contactDefaults({
          firstName: mapped.firstName ?? '',
          lastName: mapped.lastName ?? '',
          email,
          phone: mapped.phone || null,
          companyName: mapped.companyName || null,
          jobTitle: mapped.jobTitle || null,
          country: mapped.country || null,
          city: mapped.city || null,
          source: 'import',
          listIds: body.listId ? [body.listId] : [],
          consents: { email: email ? 'subscribed' : 'none' },
          attributes,
        }),
      );
    }
    // Plan limit: import what fits, skip the rest and say why.
    const room = await contactCapacity(ctx);
    const overLimit = Math.max(0, toCreate.length - room);
    if (overLimit) toCreate.length = room;
    for (let i = 0; i < toCreate.length; i += 1000) {
      await ctx.store.insertMany('contacts', toCreate.slice(i, i + 1000));
    }
    const { plan, limits } = overLimit
      ? await entitlementsOf(ctx)
      : { plan: '', limits: null };
    return ctx.store.insert('contacts/imports', {
      fileName: body.fileName.slice(0, 255),
      status: overLimit ? 'partial' : 'completed',
      totalRows: body.rows.length,
      created: toCreate.length,
      updated,
      skipped: skipped + overLimit,
      overLimit,
      note: overLimit
        ? `${overLimit.toLocaleString('en')} new contacts were not imported: the ${planName(plan)} plan includes ${limits!.contacts!.toLocaleString('en')} contacts. Upgrade, then import the file again.`
        : null,
      listId: body.listId ?? null,
    });
  }

  async activities(ctx: HookContext, contactId: string) {
    await ctx.store.find('contacts', contactId);
    const page = await ctx.store.list('activities', activitiesShape, {
      filters: { contactId },
      sort: 'at',
      order: 'desc',
      perPage: 200,
    });
    return page.data;
  }

  async addNote(ctx: HookContext, contactId: string, text: unknown) {
    if (typeof text !== 'string' || !text.trim()) {
      throw fieldError(422, 'REQUIRED', 'text', 'Write a note first');
    }
    await ctx.store.find('contacts', contactId);
    const at = new Date().toISOString();
    await ctx.store.patch('contacts', contactId, { lastActivityAt: at });
    return ctx.store.insert('activities', {
      contactId,
      type: 'note',
      channel: null,
      title: `Note: ${text.trim().slice(0, 2000)}`,
      description: '',
      authorName: ctx.actorName,
      at,
    });
  }

  async previewSegment(ctx: HookContext, rules: unknown) {
    if (!isRuleGroup(rules)) {
      throw fieldError(
        422,
        'INVALID_RULES',
        'rules',
        'Rules must be a group with match and rules',
      );
    }
    const contacts = await ctx.store.all('contacts');
    const matches = contacts.filter((c) => matchesSegment(c, rules));
    return { count: matches.length, sample: matches.slice(0, 5) };
  }

  private async findMany<T extends Row>(
    ctx: HookContext,
    ids: string[],
  ): Promise<T[]> {
    const found: T[] = [];
    for (const id of new Set(ids)) {
      const row = await ctx.store.findOrNull<T>('contacts', id);
      if (row) found.push(row);
    }
    return found;
  }
}
