import type { CollectionDef } from '../records/collection.types';
import { fieldError, invalidState } from '../records/record-store';

const DEAL_STATUSES = new Set(['open', 'won', 'lost']);

export const companiesCollection: CollectionDef = {
  path: 'companies',
  read: 'deals.read',
  write: 'deals.manage',
  searchFields: ['name', 'domain', 'industry'],
  decorate: async (ctx, rows) => {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const contactCounts = await ctx.store.em.query<{ id: string; n: string }[]>(
      `SELECT data->>'companyId' AS id, count(*) AS n FROM product_records
       WHERE tenant_id = $1 AND collection = 'contacts' AND data->>'companyId' = ANY($2::text[])
       GROUP BY 1`,
      [ctx.store.tenantId, ids],
    );
    const dealValues = await ctx.store.em.query<{ id: string; v: string }[]>(
      `SELECT data->>'companyId' AS id, coalesce(sum((data->>'value')::numeric), 0) AS v FROM product_records
       WHERE tenant_id = $1 AND collection = 'deals' AND data->>'status' = 'open'
         AND data->>'companyId' = ANY($2::text[])
       GROUP BY 1`,
      [ctx.store.tenantId, ids],
    );
    const contacts = new Map(contactCounts.map((r) => [r.id, Number(r.n)]));
    const deals = new Map(dealValues.map((r) => [r.id, Number(r.v)]));
    return rows.map((c) => ({
      ...c,
      contactCount: contacts.get(c.id) ?? 0,
      openDealsValue: deals.get(c.id) ?? 0,
    }));
  },
  beforeCreate: (_ctx, input) => {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    return {
      domain: null,
      industry: null,
      size: null,
      country: null,
      ownerName: null,
      ...input,
    };
  },
  /** Contacts and deals keep their company name but lose the link. */
  beforeDelete: async (ctx, company) => {
    await ctx.store.em.query(
      `UPDATE product_records SET data = data || '{"companyId": null}'::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND collection IN ('contacts', 'deals') AND data->>'companyId' = $2`,
      [ctx.store.tenantId, company.id],
    );
  },
};

export const pipelinesCollection: CollectionDef = {
  path: 'pipelines',
  read: 'deals.read',
  write: 'deals.manage',
  searchFields: ['name'],
  defaults: () => [
    {
      name: 'Sales pipeline',
      stages: [
        { id: 'stage-new', name: 'New', probability: 10 },
        { id: 'stage-qualified', name: 'Qualified', probability: 25 },
        { id: 'stage-demo', name: 'Demo', probability: 45 },
        { id: 'stage-proposal', name: 'Proposal', probability: 65 },
        { id: 'stage-negotiation', name: 'Negotiation', probability: 85 },
      ],
    },
  ],
  beforeDelete: async (ctx, pipeline) => {
    if (await ctx.store.count('deals', { pipelineId: pipeline.id })) {
      throw invalidState('Move or delete this pipeline’s deals first.');
    }
  },
};

export const dealsCollection: CollectionDef = {
  path: 'deals',
  read: 'deals.read',
  write: 'deals.manage',
  searchFields: ['title', 'companyName', 'contactName'],
  beforeCreate: (_ctx, input) => {
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw fieldError(422, 'REQUIRED', 'title', 'Title is required');
    }
    return {
      value: 0,
      status: 'open',
      companyId: null,
      companyName: null,
      contactId: null,
      contactName: null,
      ownerName: null,
      expectedCloseDate: null,
      ...input,
    };
  },
  beforeUpdate: (_ctx, _existing, patch) => {
    if ('status' in patch && !DEAL_STATUSES.has(String(patch.status))) {
      throw fieldError(
        422,
        'INVALID_STATUS',
        'status',
        'Status must be open, won or lost',
      );
    }
    if (
      'status' in patch &&
      patch.status !== 'open' &&
      !('closedAt' in patch)
    ) {
      return { ...patch, closedAt: new Date().toISOString() };
    }
    return patch;
  },
};

export const tasksCollection: CollectionDef = {
  path: 'tasks',
  read: 'deals.read',
  write: 'deals.manage',
  searchFields: ['title', 'assigneeName'],
  defaultSort: 'dueAt',
  beforeCreate: (_ctx, input) => {
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw fieldError(422, 'REQUIRED', 'title', 'Title is required');
    }
    return {
      done: false,
      dueAt: null,
      assigneeName: null,
      contactId: null,
      dealId: null,
      ...input,
    };
  },
};
