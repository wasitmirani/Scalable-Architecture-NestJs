import { randomBytes } from 'crypto';
import type { CollectionDef } from '../records/collection.types';
import { fieldError, text } from '../records/record-store';

export function newWebhookSecret() {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

export const formsCollection: CollectionDef = {
  path: 'forms',
  read: 'contacts.read',
  write: 'contacts.manage',
  searchFields: ['name', 'title'],
  defaultSort: 'updatedAt',
  serverFields: ['submissions', 'views'],
  beforeCreate: (_ctx, input) => ({
    submissions: 0,
    views: 0,
    status: 'draft',
    ...input,
  }),
};

function assertUrl(value: unknown): string {
  const url = text(value).trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw fieldError(
      422,
      'INVALID_URL',
      'url',
      'Enter a full URL starting with https://',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw fieldError(422, 'INVALID_URL', 'url', 'Use an http(s) URL');
  }
  return url;
}

export const webhookEndpointsCollection: CollectionDef = {
  path: 'webhook-endpoints',
  read: 'webhooks.manage',
  write: 'webhooks.manage',
  searchFields: ['url', 'description'],
  serverFields: ['secretPrefix', 'successRate', 'lastDeliveryAt'],
  beforeCreate: (_ctx, input) => {
    const secret = newWebhookSecret();
    return {
      description: '',
      events: [],
      status: 'active',
      ...input,
      url: assertUrl(input.url),
      _secret: secret,
      secretPrefix: secret.slice(0, 10),
      successRate: 1,
      lastDeliveryAt: null,
    };
  },
  beforeUpdate: (_ctx, _existing, patch) =>
    'url' in patch ? { ...patch, url: assertUrl(patch.url) } : patch,
  beforeDelete: async (ctx, endpoint) => {
    await ctx.store.removeWhere('webhook-deliveries', {
      endpointId: endpoint.id,
    });
  },
};

export const invoicesCollection: CollectionDef = {
  path: 'billing/invoices',
  read: 'billing.read',
  write: 'billing.manage',
  searchFields: ['number'],
  defaultSort: 'periodEnd',
};

export const notificationsCollection: CollectionDef = {
  path: 'notifications',
  read: null,
  write: null,
  searchFields: ['title', 'body'],
  beforeCreate: (_ctx, input) => ({
    type: 'info',
    link: null,
    read: false,
    body: '',
    ...input,
  }),
};

const INTEGRATION_APPS = [
  'slack',
  'teams',
  'google_sheets',
  'hubspot',
  'shopify',
  'zapier',
];

export const integrationsCollection: CollectionDef = {
  path: 'integrations',
  read: null,
  write: 'integrations.manage',
  searchFields: ['app', 'account'],
  serverFields: ['status', 'account', 'connectedBy', 'connectedAt'],
  defaults: () =>
    INTEGRATION_APPS.map((app) => ({
      app,
      status: 'disconnected',
      account: null,
      connectedBy: null,
      connectedAt: null,
    })),
};
