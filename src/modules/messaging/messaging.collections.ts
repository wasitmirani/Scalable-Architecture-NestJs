import type { CollectionDef } from '../records/collection.types';
import { fieldError } from '../records/record-store';

export const EMPTY_STATS = {
  recipients: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  failed: 0,
  revenue: 0,
};

const CHANNELS = new Set(['email', 'sms', 'whatsapp', 'push', 'rcs', 'voice']);

export const campaignsCollection: CollectionDef = {
  path: 'campaigns',
  read: 'campaigns.read',
  write: 'campaigns.manage',
  searchFields: ['name', 'subject'],
  // Status moves only through launch/pause/resume/cancel/unschedule.
  serverFields: ['status', 'stats', 'sentAt'],
  beforeCreate: (_ctx, input) => {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    if (!CHANNELS.has(String(input.channel))) {
      throw fieldError(422, 'INVALID_CHANNEL', 'channel', 'Pick a channel');
    }
    return {
      senderAccountId: null,
      senderLabel: null,
      subject: null,
      previewText: null,
      templateId: null,
      body: '',
      abTest: null,
      tags: [],
      audience: { listIds: [], segmentIds: [], excludeListIds: [] },
      schedule: { type: 'now', at: null, timezone: 'UTC' },
      ...input,
      status: 'draft',
      stats: EMPTY_STATS,
      sentAt: null,
    };
  },
};

export const templatesCollection: CollectionDef = {
  path: 'templates',
  read: null,
  write: 'templates.manage',
  searchFields: ['name', 'subject', 'body'],
  defaultSort: 'updatedAt',
  serverFields: ['rejectionReason'],
  beforeCreate: (_ctx, input) => {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    // WhatsApp templates need provider approval; other channels are usable once saved.
    const status =
      input.channel === 'whatsapp' ? 'draft' : (input.status ?? 'active');
    return {
      blocks: [],
      examples: {},
      subject: null,
      body: '',
      ...input,
      status,
      rejectionReason: null,
    };
  },
  beforeUpdate: (_ctx, existing, patch) => {
    // Approval is the provider's decision; editing an approved WhatsApp template needs re-approval.
    if (existing.channel === 'whatsapp') {
      const rest = { ...patch };
      delete rest.status;
      const contentChanged = [
        'body',
        'header',
        'footer',
        'buttons',
        'examples',
      ].some((k) => k in rest);
      return contentChanged && existing.status === 'approved'
        ? { ...rest, status: 'draft' }
        : rest;
    }
    return patch;
  },
};

export const messagesCollection: CollectionDef = {
  path: 'messages',
  read: 'messages.read',
  write: 'channels.manage',
  searchFields: ['to', 'from', 'contactName', 'subject', 'preview'],
  serverFields: ['status', 'events'],
};
