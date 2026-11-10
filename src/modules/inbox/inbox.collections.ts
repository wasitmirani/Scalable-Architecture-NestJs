import type { CollectionDef } from '../records/collection.types';
import { fieldError, text } from '../records/record-store';

const STATUSES = new Set(['open', 'pending', 'snoozed', 'resolved']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

export const conversationsCollection: CollectionDef = {
  path: 'conversations',
  read: 'inbox.read',
  write: 'inbox.assign',
  searchFields: [
    'contactName',
    'contactHandle',
    'subject',
    'lastMessagePreview',
  ],
  defaultSort: 'lastMessageAt',
  serverFields: ['lastMessageAt', 'lastMessagePreview', 'unreadCount'],
  beforeCreate: (_ctx, input) => ({
    status: 'open',
    priority: 'normal',
    assigneeName: null,
    teamName: null,
    subject: null,
    tags: [],
    unreadCount: 0,
    windowExpiresAt: null,
    lastMessagePreview: '',
    lastMessageAt: new Date().toISOString(),
    ...input,
  }),
  beforeUpdate: (_ctx, _existing, patch) => {
    if ('status' in patch && !STATUSES.has(String(patch.status))) {
      throw fieldError(
        422,
        'INVALID_STATUS',
        'status',
        'Unknown conversation status',
      );
    }
    if ('priority' in patch && !PRIORITIES.has(String(patch.priority))) {
      throw fieldError(422, 'INVALID_PRIORITY', 'priority', 'Unknown priority');
    }
    if ('tags' in patch) {
      patch.tags = [
        ...new Set((Array.isArray(patch.tags) ? patch.tags : []).map(String)),
      ];
    }
    return patch;
  },
  beforeDelete: async (ctx, conversation) => {
    await ctx.store.removeWhere('conversation-messages', {
      conversationId: conversation.id,
    });
  },
};

export const cannedRepliesCollection: CollectionDef = {
  path: 'canned-replies',
  read: 'inbox.read',
  write: 'inbox.reply',
  searchFields: ['shortcut', 'title', 'body'],
  defaults: () => [
    {
      shortcut: '/thanks',
      title: 'Thanks',
      body: 'Thanks for reaching out! Is there anything else I can help you with?',
    },
    {
      shortcut: '/hours',
      title: 'Opening hours',
      body: 'We are open Monday to Friday, 9:00–18:00.',
    },
  ],
  beforeCreate: (_ctx, input) => {
    const shortcut = text(input.shortcut).trim();
    if (!/^\/[a-z0-9_-]{1,32}$/i.test(shortcut)) {
      throw fieldError(
        422,
        'INVALID_SHORTCUT',
        'shortcut',
        'Start with / and use letters, numbers, - or _',
      );
    }
    return { ...input, shortcut };
  },
};

export const conversationMessagesShape = {
  searchFields: ['body'],
  defaultSort: 'at',
};
