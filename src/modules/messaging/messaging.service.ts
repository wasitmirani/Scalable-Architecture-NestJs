import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { HookContext } from '../records/collection.types';
import {
  fieldError,
  invalidState,
  text,
  type Row,
} from '../records/record-store';
import { matchesSegment, type SegmentRuleGroup } from '../crm/segment-engine';
import { EMPTY_STATS } from './messaging.collections';
import { publicRow } from '../records/records.service';
import { assertEmailQuota, assertFeature } from '../platform/plan-limits';
import { open } from '../../common/crypto/secret-box';
import { whatsappSubmitTemplate } from '../delivery/messaging-transport';
import type { Credentials } from '../delivery/providers';

interface Audience {
  listIds: string[];
  segmentIds: string[];
  excludeListIds: string[];
}

type Campaign = Row & {
  name: string;
  channel: string;
  status: string;
  subject: string | null;
  body: string;
  templateId: string | null;
  senderLabel: string | null;
  audience: Audience;
  schedule: { type: string; at: string | null };
  stats: typeof EMPTY_STATS;
};

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function normalizeAudience(v: unknown): Audience {
  const a = (v ?? {}) as Partial<Audience>;
  return {
    listIds: ids(a.listIds),
    segmentIds: ids(a.segmentIds),
    excludeListIds: ids(a.excludeListIds),
  };
}

/** Sending requires a provider integration that no backend phase has built yet. */
export function providerNotConnected(channel: string) {
  return new HttpException(
    {
      message: `Sending ${channel} needs a connected provider, and none is configured on this server yet.`,
      error: 'Conflict',
      code: 'PROVIDER_NOT_CONNECTED',
    },
    HttpStatus.CONFLICT,
  );
}

/** A template in Meta's message_templates format (header, body with examples, footer, buttons). */
export function whatsappComponents(t: Row): Record<string, unknown>[] {
  const wa = (t.whatsapp ?? {}) as {
    headerType?: string;
    header?: string;
    footer?: string;
    buttons?: { type: string; text: string; value?: string }[];
  };
  const examples = (t.examples ?? {}) as Record<string, string>;
  const body = text(t.body);
  const numbers = [
    ...new Set([...body.matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => Number(m[1]))),
  ].sort((a, b) => a - b);
  const components: Record<string, unknown>[] = [];
  if (wa.headerType === 'text' && wa.header)
    components.push({ type: 'HEADER', format: 'TEXT', text: wa.header });
  if (wa.headerType === 'image' && wa.header)
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [wa.header] },
    });
  components.push({
    type: 'BODY',
    text: body,
    ...(numbers.length
      ? {
          example: {
            body_text: [numbers.map((n) => examples[n] || `value ${n}`)],
          },
        }
      : {}),
  });
  if (wa.footer) components.push({ type: 'FOOTER', text: wa.footer });
  if (wa.buttons?.length) {
    components.push({
      type: 'BUTTONS',
      buttons: wa.buttons.map((b) =>
        b.type === 'url'
          ? { type: 'URL', text: b.text, url: b.value ?? '' }
          : b.type === 'phone'
            ? {
                type: 'PHONE_NUMBER',
                text: b.text,
                phone_number: b.value ?? '',
              }
            : { type: 'QUICK_REPLY', text: b.text },
      ),
    });
  }
  return components;
}

/** Same checks as the UI's campaignProblems(); the server re-validates on launch. */
function campaignProblems(c: Campaign, due = false): string[] {
  const problems: string[] = [];
  if (!c.senderLabel) problems.push('Choose a sender.');
  if (c.channel === 'email' && !c.subject?.trim())
    problems.push('Add a subject line.');
  if (!c.body?.trim() && !c.templateId)
    problems.push('Add content or pick a template.');
  const a = normalizeAudience(c.audience);
  if (a.listIds.length + a.segmentIds.length === 0) {
    problems.push('Choose at least one list or segment.');
  }
  if (
    !due &&
    c.schedule?.type === 'scheduled' &&
    (!c.schedule.at || Date.parse(c.schedule.at) < Date.now())
  ) {
    problems.push('Pick a send time in the future.');
  }
  return problems;
}

@Injectable()
export class MessagingService {
  /** Contacts in the audience, and those reachable on the channel (consent, address, not blocklisted). */
  async audience(ctx: HookContext, audienceInput: unknown, channel: string) {
    const audience = normalizeAudience(audienceInput);
    const segments = await Promise.all(
      audience.segmentIds.map((id) => ctx.store.find('segments', id)),
    );
    const all = await ctx.store.all('contacts');
    const inList = (c: Row, listIds: string[]) =>
      listIds.some((l) => ids(c.listIds).includes(l));
    const members = all.filter(
      (c) =>
        (inList(c, audience.listIds) ||
          segments.some((s) =>
            matchesSegment(c, s.rules as SegmentRuleGroup),
          )) &&
        !inList(c, audience.excludeListIds),
    );
    const consentKey =
      channel === 'email'
        ? 'email'
        : channel === 'whatsapp'
          ? 'whatsapp'
          : 'sms';
    const reachable = members.filter((c) => {
      const address = channel === 'email' ? c.email : c.phone;
      const consents = (c.consents ?? {}) as Record<string, string>;
      return (
        !c.blocklisted && !!address && consents[consentKey] === 'subscribed'
      );
    });
    return { members, reachable };
  }

  async estimate(ctx: HookContext, audience: unknown, channel: string) {
    const { members, reachable } = await this.audience(ctx, audience, channel);
    return {
      total: members.length,
      reachable: reachable.length,
      excluded: members.length - reachable.length,
    };
  }

  private async transition(
    ctx: HookContext,
    id: string,
    from: string[],
    to: string,
    extra: Record<string, unknown> = {},
  ) {
    const campaign = await ctx.store.find<Campaign>('campaigns', id);
    if (!from.includes(campaign.status)) {
      throw invalidState(
        `A ${campaign.status} campaign cannot be changed to ${to}.`,
      );
    }
    return ctx.store.patch('campaigns', id, { status: to, ...extra });
  }

  /**
   * Sends now or schedules. Sending queues one message per reachable contact in the
   * message log; delivery happens once a channel provider is connected.
   */
  async launch(ctx: HookContext, id: string, opts: { due?: boolean } = {}) {
    const campaign = await ctx.store.find<Campaign>('campaigns', id);
    const problems = campaignProblems(campaign, opts.due);
    if (problems.length) {
      throw new HttpException(
        {
          message: problems.join(' '),
          error: 'Unprocessable Entity',
          code: 'CAMPAIGN_INVALID',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    // `due`: the delivery worker launches a scheduled campaign whose time has come.
    if ((campaign.abTest as { enabled?: boolean } | null)?.enabled)
      await assertFeature(ctx, 'abTesting');
    if (campaign.schedule?.type === 'scheduled' && !opts.due) {
      return this.transition(ctx, id, ['draft'], 'scheduled');
    }
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      throw invalidState(`A ${campaign.status} campaign cannot be launched.`);
    }
    const { reachable } = await this.audience(
      ctx,
      campaign.audience,
      campaign.channel,
    );
    if (campaign.channel === 'email')
      await assertEmailQuota(ctx, reachable.length);
    const at = new Date().toISOString();
    const preview = (campaign.body ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    const logs = reachable.map((c) => ({
      channel: campaign.channel,
      direction: 'outbound',
      to: campaign.channel === 'email' ? c.email : c.phone,
      from: campaign.senderLabel,
      contactId: c.id,
      contactName: `${text(c.firstName)} ${text(c.lastName)}`.trim() || null,
      subject: campaign.subject,
      preview,
      status: 'queued',
      provider: 'unassigned',
      segments: null,
      cost: 0,
      campaignId: campaign.id,
      campaignName: campaign.name,
      errorCode: null,
      events: [{ status: 'queued', at, detail: 'Queued by campaign launch' }],
    }));
    for (let i = 0; i < logs.length; i += 1000) {
      await ctx.store.insertMany('messages', logs.slice(i, i + 1000));
    }
    return ctx.store.patch('campaigns', id, {
      status: 'running',
      sentAt: at,
      stats: {
        ...EMPTY_STATS,
        ...campaign.stats,
        recipients: reachable.length,
      },
    });
  }

  pause = (ctx: HookContext, id: string) =>
    this.transition(ctx, id, ['running'], 'paused');
  resume = (ctx: HookContext, id: string) =>
    this.transition(ctx, id, ['paused'], 'running');
  cancel = (ctx: HookContext, id: string) =>
    this.transition(ctx, id, ['scheduled', 'running', 'paused'], 'cancelled');
  unschedule = (ctx: HookContext, id: string) =>
    this.transition(ctx, id, ['scheduled'], 'draft');

  async duplicateCampaign(ctx: HookContext, id: string) {
    const source = await ctx.store.find<Campaign>('campaigns', id);
    return ctx.store.insert('campaigns', {
      ...source,
      name: `${source.name} (copy)`,
      status: 'draft',
      sentAt: null,
      stats: EMPTY_STATS,
    });
  }

  async duplicateTemplate(ctx: HookContext, id: string) {
    const source = await ctx.store.find('templates', id);
    return ctx.store.insert('templates', {
      ...source,
      name: `${String(source.name)} copy`,
      status: source.channel === 'whatsapp' ? 'draft' : 'active',
      rejectionReason: null,
    });
  }

  /** WhatsApp templates go to the provider for approval. */
  async submitTemplate(ctx: HookContext, id: string) {
    const template = await ctx.store.find('templates', id);
    if (template.channel !== 'whatsapp') {
      throw invalidState('Only WhatsApp templates need approval.');
    }
    if (template.status === 'pending') {
      throw invalidState('This template is already waiting for approval.');
    }
    // Sent to Meta for review; the delivery worker polls the result (approved / rejected).
    const [account] = (
      await ctx.store.all('channel-accounts', { channel: 'whatsapp' })
    ).filter(
      (a) => a.status === 'connected' && typeof a._credentials === 'string',
    );
    if (!account)
      throw providerNotConnected(
        'WhatsApp (connect the WhatsApp Cloud API first)',
      );
    const metaName =
      text(template.name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 512) || `template_${id.slice(0, 8)}`;
    try {
      const submitted = await whatsappSubmitTemplate(
        open<Credentials>(text(account._credentials)),
        {
          name: metaName,
          language: text(template.language) || 'en',
          category: (['marketing', 'utility', 'authentication'].includes(
            text(template.category),
          )
            ? text(template.category)
            : 'marketing'
          ).toUpperCase(),
          components: whatsappComponents(template),
        },
      );
      return publicRow(
        await ctx.store.patch('templates', id, {
          status:
            submitted.status === 'APPROVED'
              ? 'approved'
              : submitted.status === 'REJECTED'
                ? 'rejected'
                : 'pending',
          metaName,
          metaId: submitted.id,
          rejectionReason: null,
        }),
      );
    } catch (error) {
      throw fieldError(
        422,
        'META_REJECTED',
        'template',
        (error as Error).message,
      );
    }
  }

  async retryMessage(ctx: HookContext, id: string) {
    const message = await ctx.store.find('messages', id);
    if (message.status !== 'failed') {
      throw invalidState('Only failed messages can be retried.');
    }
    const events: unknown[] = Array.isArray(message.events)
      ? (message.events as unknown[])
      : [];
    const updated = await ctx.store.patch('messages', id, {
      status: 'queued',
      errorCode: null,
      // A manual retry starts a fresh series of attempts.
      _attempts: 0,
      _nextAttemptAt: null,
      _lockedAt: null,
      events: [
        ...events,
        {
          status: 'queued',
          at: new Date().toISOString(),
          detail: 'Manual retry',
        },
      ],
    });
    return publicRow(updated);
  }

  /** One brand kit per workspace, created on first read. */
  async brandKit(ctx: HookContext) {
    const [existing] = await ctx.store.all('brand-kit');
    if (existing) return existing;
    return ctx.store.insert('brand-kit', {
      header: [],
      footer: [
        { id: 'bk-f1', type: 'divider', content: '' },
        {
          id: 'bk-f2',
          type: 'footer',
          content:
            'You receive this because you subscribed · {{unsubscribe_url}}',
          align: 'center',
        },
      ],
      design: {
        accent: '#5b5bd6',
        background: '#f1f5f9',
        paper: '#ffffff',
        text: '#1f2937',
        font: 'Inter',
        radius: 8,
      },
      whatsappFooter: '',
      smsPrefix: '',
    });
  }

  async updateBrandKit(ctx: HookContext, patch: unknown) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw fieldError(
        422,
        'INVALID_BODY',
        'body',
        'Send the brand kit fields to change',
      );
    }
    const kit = await this.brandKit(ctx);
    const allowed = [
      'header',
      'footer',
      'design',
      'whatsappFooter',
      'smsPrefix',
    ];
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([k]) => allowed.includes(k)),
    );
    return ctx.store.patch('brand-kit', kit.id, changes);
  }
}
