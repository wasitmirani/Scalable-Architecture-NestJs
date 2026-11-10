import { forwardRef, Inject, Injectable } from '@nestjs/common';
import type { HookContext } from '../records/collection.types';
import { text, type Row } from '../records/record-store';
import { contactDefaults } from '../crm/crm.collections';
import { AutomationService } from '../automation/automation.service';
import { contactCapacity } from '../platform/plan-limits';

export type InboundChannel = 'sms' | 'whatsapp' | 'telegram' | 'email';

export interface InboundMessage {
  channel: InboundChannel;
  accountId: string;
  /** Phone number (E.164), Telegram chat id or email address. */
  from: string;
  /** Display name the provider gives (WhatsApp profile, Telegram name). */
  name?: string;
  body: string;
  providerMessageId?: string;
  at?: string;
}

/** Provider delivery states mapped to the message log's statuses. */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 9,
  bounced: 9,
};

const STOP_WORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
]);
const START_WORDS = new Set(['start', 'unstop', 'subscribe']);

/** WhatsApp lets businesses reply freely for 24 hours after the customer's last message. */
const WINDOW_MS = 24 * 3600_000;

const e164 = (phone: string) => {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
};

/**
 * Incoming messages and provider status callbacks, for every channel: finds or
 * creates the contact and conversation, writes the message to the inbox and the
 * message log, applies SMS STOP/START, and fires "Message received" automations.
 */
@Injectable()
export class InboundService {
  constructor(
    @Inject(forwardRef(() => AutomationService))
    private readonly automation: AutomationService,
  ) {}

  private async findContact(
    ctx: HookContext,
    m: InboundMessage,
  ): Promise<Row | null> {
    const [row] =
      m.channel === 'telegram'
        ? await ctx.store.em.query<{ id: string }[]>(
            `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'
              AND data->'attributes'->>'telegram_chat_id' = $2 LIMIT 1`,
            [ctx.store.tenantId, m.from],
          )
        : m.channel === 'email'
          ? await ctx.store.em.query<{ id: string }[]>(
              `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'contacts' AND lower(data->>'email') = lower($2) LIMIT 1`,
              [ctx.store.tenantId, m.from],
            )
          : await ctx.store.em.query<{ id: string }[]>(
              // Phones are compared on digits, so "+1 (415) 555-0100" matches "+14155550100".
              `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'
                AND regexp_replace(coalesce(data->>'phone', ''), '[^0-9]', '', 'g') = $2 LIMIT 1`,
              [ctx.store.tenantId, m.from.replace(/\D/g, '')],
            );
    return row ? ctx.store.find('contacts', row.id) : null;
  }

  async receive(ctx: HookContext, m: InboundMessage) {
    const at = m.at ?? new Date().toISOString();
    const from =
      m.channel === 'sms' || m.channel === 'whatsapp' ? e164(m.from) : m.from;
    let contact = await this.findContact(ctx, { ...m, from });
    if (!contact && (await contactCapacity(ctx)) > 0) {
      const [first, ...rest] = (m.name ?? '').trim().split(/\s+/);
      contact = await ctx.store.insert(
        'contacts',
        contactDefaults({
          firstName: first ?? '',
          lastName: rest.join(' '),
          ...(m.channel === 'telegram'
            ? { attributes: { telegram_chat_id: from } }
            : m.channel === 'email'
              ? { email: from.toLowerCase() }
              : { phone: from }),
          source: 'inbound',
        }),
      );
    }
    const contactName = contact
      ? `${text(contact.firstName)} ${text(contact.lastName)}`.trim() ||
        m.name ||
        from
      : m.name || from;

    // SMS keywords: STOP opts out of SMS, START opts back in (carriers require honouring both).
    const word = m.body.trim().toLowerCase();
    if (
      contact &&
      m.channel === 'sms' &&
      (STOP_WORDS.has(word) || START_WORDS.has(word))
    ) {
      const consents = (contact.consents ?? {}) as Record<string, string>;
      await ctx.store.patch('contacts', contact.id, {
        consents: {
          ...consents,
          sms: STOP_WORDS.has(word) ? 'unsubscribed' : 'subscribed',
        },
      });
    }

    // One open conversation per contact and channel.
    const [open] = await ctx.store.em.query<{ id: string }[]>(
      `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'conversations'
        AND data->>'channel' = $2 AND data->>'contactHandle' = $3 AND data->>'status' <> 'resolved'
        ORDER BY updated_at DESC LIMIT 1`,
      [ctx.store.tenantId, m.channel, from],
    );
    const conversation = open
      ? await ctx.store.find('conversations', open.id)
      : await ctx.store.insert('conversations', {
          contactId: contact?.id ?? null,
          contactName,
          contactHandle: from,
          channel: m.channel,
          accountId: m.accountId,
          subject: null,
          status: 'open',
          priority: 'normal',
          assigneeName: null,
          teamName: null,
          tags: [],
          unreadCount: 0,
          windowExpiresAt: null,
          lastMessagePreview: '',
          lastMessageAt: at,
        });
    await ctx.store.insert('conversation-messages', {
      conversationId: conversation.id,
      direction: 'inbound',
      kind: 'message',
      body: m.body,
      authorName: contactName,
      status: null,
      attachments: [],
      at,
      providerMessageId: m.providerMessageId ?? null,
    });
    await ctx.store.patch('conversations', conversation.id, {
      lastMessagePreview: m.body.slice(0, 200),
      lastMessageAt: at,
      unreadCount: (Number(conversation.unreadCount) || 0) + 1,
      status: conversation.status === 'snoozed' ? 'open' : conversation.status,
      accountId: m.accountId,
      ...(m.channel === 'whatsapp'
        ? {
            windowExpiresAt: new Date(Date.parse(at) + WINDOW_MS).toISOString(),
          }
        : {}),
    });
    await ctx.store.insert('messages', {
      channel: m.channel,
      direction: 'inbound',
      to: null,
      from,
      contactId: contact?.id ?? null,
      contactName,
      subject: null,
      preview: m.body.slice(0, 140),
      status: 'received',
      provider: m.channel,
      providerMessageId: m.providerMessageId ?? null,
      campaignId: null,
      campaignName: null,
      errorCode: null,
      events: [{ status: 'received', at, detail: 'Received' }],
    });
    if (contact) {
      await ctx.store.patch('contacts', contact.id, { lastActivityAt: at });
      await ctx.store.insert('activities', {
        contactId: contact.id,
        type: 'message_received',
        channel: m.channel,
        title: `Message received on ${m.channel}`,
        description: m.body.slice(0, 500),
        authorName: contactName,
        at,
      });
      await this.automation.fire(ctx, {
        type: 'message_received',
        contactId: contact.id,
        key: m.channel,
        values: {
          channel: m.channel,
          message_text: m.body,
          conversation_id: conversation.id,
          occurred_at: at,
        },
      });
    }
    return { conversationId: conversation.id, contactId: contact?.id ?? null };
  }

  /**
   * Provider status callback (Twilio, Meta): moves the message forward
   * (sent → delivered → read), never backwards, and mirrors it to the inbox reply.
   */
  async status(
    ctx: HookContext,
    providerMessageId: string,
    status: string,
    error?: { code: string; message: string },
  ) {
    if (!providerMessageId) return false;
    const [row] = await ctx.store.em.query<{ id: string }[]>(
      `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'messages' AND data->>'providerMessageId' = $2 LIMIT 1`,
      [ctx.store.tenantId, providerMessageId],
    );
    if (!row) return false;
    const msg = await ctx.store.find('messages', row.id);
    const current = text(msg.status);
    if (
      (STATUS_RANK[status] ?? -1) <= (STATUS_RANK[current] ?? -1) &&
      status !== 'failed'
    )
      return true;
    if (current === 'failed') return true;
    const at = new Date().toISOString();
    await ctx.store.patch('messages', msg.id, {
      status,
      ...(error ? { errorCode: error.code } : {}),
      events: [
        ...((msg.events as unknown[]) ?? []),
        {
          status,
          at,
          detail: error ? error.message : `Provider reported ${status}`,
        },
      ],
    });
    if (msg.campaignId) ctx.store.touch('campaigns', text(msg.campaignId));
    if (
      msg.campaignId &&
      (status === 'delivered' || status === 'read' || status === 'failed')
    ) {
      const field =
        status === 'failed'
          ? 'failed'
          : status === 'read'
            ? 'opened'
            : 'delivered';
      await ctx.store.em.query(
        `UPDATE product_records SET data = jsonb_set(data, ARRAY['stats', $3::text], to_jsonb(COALESCE((data->'stats'->>$3)::int, 0) + 1)), updated_at = now()
          WHERE tenant_id = $1 AND collection = 'campaigns' AND id = $2`,
        [ctx.store.tenantId, msg.campaignId, field],
      );
      // A message read on WhatsApp was also delivered.
      if (status === 'read' && current !== 'delivered')
        await ctx.store.em.query(
          `UPDATE product_records SET data = jsonb_set(data, '{stats,delivered}', to_jsonb(COALESCE((data->'stats'->>'delivered')::int, 0) + 1)) WHERE tenant_id = $1 AND collection = 'campaigns' AND id = $2`,
          [ctx.store.tenantId, msg.campaignId],
        );
    }
    if (msg.conversationMessageId)
      await ctx.store.patch(
        'conversation-messages',
        text(msg.conversationMessageId),
        { status },
      );
    return true;
  }
}
