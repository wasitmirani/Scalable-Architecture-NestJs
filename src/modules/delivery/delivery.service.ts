import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { open } from '../../common/crypto/secret-box';
import type { HookContext } from '../records/collection.types';
import { fieldError, text, type Row } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { MessagingService } from '../messaging/messaging.service';
import {
  blocksToHtml,
  composeEmail,
  emailText,
  htmlToText,
  personalize,
  recipientValues,
  textToHtml,
  type EmailBlock,
  type EmailDesign,
} from './email-render';
import { describeSendError, emailSender, type EmailSender, type OutgoingEmail } from './email-transport';
import { checkCredentials, type CheckResult } from './account-check';
import { providerOf, type Credentials } from './providers';
import { publicApiUrl, unsubscribeToken } from './unsubscribe-token';

const POLL_MS = 5_000;
const BATCH = 50;
const MAX_ATTEMPTS = 5;
/** Waits before attempts 2, 3, 4 and 5. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
/** A claim older than this belongs to a worker that died; the row is taken again. */
const STALE_LOCK = '10 minutes';

type Message = Row & {
  channel: string;
  status: string;
  to: string | null;
  contactId: string | null;
  campaignId: string | null;
  runId?: string | null;
  templateRef?: string | null;
  subject: string | null;
  events?: unknown[];
  _attempts?: number;
};

interface Content {
  subject: string;
  html: string;
  text: string;
  /** Marketing mail carries the unsubscribe header; test sends and transactional mail may not. */
  marketing: boolean;
}

class DeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent = true,
  ) {
    super(message);
  }
}

/** Per-transaction lookups, so a batch does not reload the same rows. */
interface Lookups {
  account?: { row: Row; sender: EmailSender; label: string } | null;
  kit?: Row | null;
  templates: Map<string, Row | null>;
  campaigns: Map<string, Row | null>;
  senders?: Row[];
}

const emailOf = (label: string) => /<([^>]+@[^>]+)>/.exec(label)?.[1] ?? (/^\S+@\S+$/.test(label.trim()) ? label.trim() : null);

/**
 * Email delivery worker: a Postgres-backed queue over `messages` rows with status
 * `queued`. Claims with FOR UPDATE SKIP LOCKED (safe with several API instances),
 * sends through the workspace's email account, retries with backoff and records
 * every attempt in the message's events. At-least-once: a worker that dies between
 * sending and saving may cause one duplicate after the stale-lock timeout.
 * DELIVERY_WORKER=off disables the loop (e.g. when a separate worker process runs it).
 */
@Injectable()
export class DeliveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => RecordsService))
    private readonly records: RecordsService,
    @Inject(forwardRef(() => MessagingService))
    private readonly messaging: MessagingService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.DELIVERY_WORKER === 'off' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.launchDueCampaigns();
      while ((await this.processBatch()) === BATCH) {
        /* keep draining while full batches come back */
      }
    } catch (error) {
      this.logger.error(`Delivery sweep failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Scheduled campaigns whose send time has passed are launched (they queue their messages). */
  async launchDueCampaigns(): Promise<number> {
    const due = await this.dataSource.query<{ id: string; tenant_id: string }[]>(
      `SELECT id, tenant_id FROM product_records
        WHERE collection = 'campaigns' AND data->>'status' = 'scheduled'
          AND (data->'schedule'->>'at')::timestamptz <= now()
        ORDER BY (data->'schedule'->>'at')::timestamptz LIMIT 20`,
    );
    for (const c of due) {
      const tenant = { tenantId: c.tenant_id, memberId: null, roleKey: null, permissions: new Set<string>() };
      try {
        await this.records.run(tenant, 'Scheduler', (ctx) => this.messaging.launch(ctx, c.id, { due: true }));
        this.logger.log(`Launched scheduled campaign ${c.id}`);
      } catch (error) {
        // A campaign that became invalid (e.g. its list was deleted) fails instead of retrying forever.
        await this.records.run(tenant, 'Scheduler', (ctx) =>
          ctx.store.patch('campaigns', c.id, { status: 'failed' }),
        );
        this.logger.warn(`Scheduled campaign ${c.id} could not launch: ${(error as Error).message}`);
      }
    }
    return due.length;
  }

  /** Claims up to BATCH due email messages and delivers them. Returns how many were claimed. */
  async processBatch(): Promise<number> {
    // The connection role owns the table, so this cross-tenant claim is not limited by RLS.
    const claimed = await this.dataSource.query<{ id: string; tenant_id: string }[]>(
      `UPDATE product_records p
          SET data = p.data || jsonb_build_object('_lockedAt', now())
         FROM (
           SELECT id FROM product_records
            WHERE collection = 'messages'
              AND data->>'status' = 'queued'
              AND data->>'channel' = 'email'
              AND COALESCE((data->>'_nextAttemptAt')::timestamptz, created_at) <= now()
              AND (data->>'_lockedAt' IS NULL OR (data->>'_lockedAt')::timestamptz < now() - interval '${STALE_LOCK}')
            ORDER BY created_at
            LIMIT ${BATCH}
            FOR UPDATE SKIP LOCKED
         ) due
        WHERE p.id = due.id
        RETURNING p.id, p.tenant_id`,
    );
    const rows = Array.isArray(claimed[0]) ? (claimed[0] as typeof claimed) : claimed;
    const byTenant = new Map<string, string[]>();
    for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.id]);

    for (const [tenantId, ids] of byTenant) {
      const tenant = { tenantId, memberId: null, roleKey: null, permissions: new Set<string>() };
      const lookups: Lookups = { templates: new Map(), campaigns: new Map() };
      try {
        for (const id of ids) {
          // One transaction per message: a crash never rolls back other sends' status.
          await this.records.run(tenant, 'Delivery', (ctx) => this.deliver(ctx, id, lookups));
        }
      } finally {
        lookups.account?.sender.close();
      }
    }
    return rows.length;
  }

  // ---------- One message ----------

  private async deliver(ctx: HookContext, id: string, lookups: Lookups) {
    const msg = await ctx.store.findOrNull<Message>('messages', id);
    if (!msg || msg.status !== 'queued') return;
    const attempt = (msg._attempts ?? 0) + 1;
    try {
      const contact = msg.contactId ? await ctx.store.findOrNull('contacts', msg.contactId) : null;
      if (contact?.blocklisted) throw new DeliveryError('SUPPRESSED', 'The contact is blocklisted.');
      const content = await this.content(ctx, msg, contact, lookups);
      if (content.marketing && (contact?.consents as { email?: string } | undefined)?.email === 'unsubscribed')
        throw new DeliveryError('UNSUBSCRIBED', 'The contact unsubscribed from email.');
      const to = msg.to || text(contact?.email);
      if (!to) throw new DeliveryError('NO_ADDRESS', 'The contact has no email address.');

      const account = await this.account(ctx, lookups, msg.campaignId ? await this.campaign(ctx, msg.campaignId, lookups) : null);
      const from = await this.fromAddress(ctx, lookups, account.sender, msg.campaignId ? await this.campaign(ctx, msg.campaignId, lookups) : null);

      const headers: Record<string, string> = { 'X-LinqFlow-Message-Id': msg.id };
      if (content.marketing && contact) {
        const url = `${publicApiUrl()}/unsubscribe/${unsubscribeToken(ctx.tenant.tenantId, contact.id)}`;
        headers['List-Unsubscribe'] = `<${url}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      const { providerMessageId } = await account.sender.send({ from: from.from, replyTo: from.replyTo, to, subject: content.subject, html: content.html, text: content.text, headers });

      const at = new Date().toISOString();
      await ctx.store.patch('messages', id, {
        status: 'sent',
        provider: account.label,
        providerMessageId,
        sentAt: at,
        errorCode: null,
        _attempts: attempt,
        _lockedAt: null,
        _nextAttemptAt: null,
        events: [...(msg.events ?? []), { status: 'sent', at, detail: `Accepted by ${account.label}` }],
      });
      await this.campaignProgress(ctx, msg.campaignId, 'sent');
    } catch (error) {
      await this.failed(ctx, msg, attempt, error);
    }
  }

  private async failed(ctx: HookContext, msg: Message, attempt: number, error: unknown) {
    const at = new Date().toISOString();
    const reason =
      error instanceof DeliveryError
        ? { code: error.code, message: error.message, permanent: error.permanent }
        : describeSendError(error);
    const final = reason.permanent || attempt >= MAX_ATTEMPTS;
    const retryAt = final ? null : new Date(Date.now() + BACKOFF_MS[attempt - 1]).toISOString();
    await ctx.store.patch('messages', msg.id, {
      status: final ? 'failed' : 'queued',
      errorCode: reason.code,
      _attempts: attempt,
      _lockedAt: null,
      _nextAttemptAt: retryAt,
      events: [
        ...(msg.events ?? []),
        final
          ? { status: 'failed', at, detail: `${reason.message} (attempt ${attempt})` }
          : { status: 'retrying', at, detail: `${reason.message} — retrying at ${retryAt} (attempt ${attempt} of ${MAX_ATTEMPTS})` },
      ],
    });
    if (final) await this.campaignProgress(ctx, msg.campaignId, 'failed');
    if (!(error instanceof DeliveryError))
      this.logger.warn(`Message ${msg.id} attempt ${attempt} failed: ${reason.code} ${reason.message}`);
  }

  /** Counts the result on the campaign and completes it when nothing is left to send. */
  private async campaignProgress(ctx: HookContext, campaignId: string | null, field: 'sent' | 'failed') {
    if (!campaignId) return;
    await ctx.store.em.query(
      `UPDATE product_records
          SET data = jsonb_set(data, ARRAY['stats', $3::text], to_jsonb(COALESCE((data->'stats'->>$3)::int, 0) + 1)), updated_at = now()
        WHERE tenant_id = $1 AND collection = 'campaigns' AND id = $2`,
      [ctx.store.tenantId, campaignId, field],
    );
    const pending = await ctx.store.count('messages', { campaignId, status: 'queued' });
    if (!pending) {
      await ctx.store.em.query(
        `UPDATE product_records SET data = data || '{"status":"completed"}'::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND collection = 'campaigns' AND id = $2 AND data->>'status' = 'running'`,
        [ctx.store.tenantId, campaignId],
      );
    }
  }

  // ---------- Content ----------

  private async campaign(ctx: HookContext, id: string, lookups: Lookups) {
    if (!lookups.campaigns.has(id)) lookups.campaigns.set(id, await ctx.store.findOrNull('campaigns', id));
    return lookups.campaigns.get(id) ?? null;
  }

  /** An email template by id, or by name (automation steps store the name). */
  private async template(ctx: HookContext, ref: string, lookups: Lookups) {
    if (!lookups.templates.has(ref)) {
      const byId = /^[0-9a-f-]{36}$/i.test(ref) ? await ctx.store.findOrNull('templates', ref) : null;
      const found =
        byId ??
        (await ctx.store.all('templates', { channel: 'email' })).find((t) => text(t.name).trim().toLowerCase() === ref.trim().toLowerCase()) ??
        null;
      lookups.templates.set(ref, found);
    }
    return lookups.templates.get(ref) ?? null;
  }

  private async brandKit(ctx: HookContext, lookups: Lookups) {
    if (lookups.kit === undefined) lookups.kit = (await ctx.store.all('brand-kit'))[0] ?? null;
    return lookups.kit;
  }

  /** Renders a template (or plain body) for one recipient. */
  async render(
    ctx: HookContext,
    source: { template: Row | null; subject?: string | null; previewText?: string | null; body?: string },
    contact: Row | null,
    extra: Record<string, string>,
    lookups: Lookups = { templates: new Map(), campaigns: new Map() },
  ): Promise<Omit<Content, 'marketing'>> {
    const t = source.template;
    const subject = (source.subject || text(t?.subject) || '').trim();
    const preview = source.previewText ?? text(t?.previewText);
    let html: string;
    let plain: string;
    if (t && t.editor === 'html' && text(t.html).trim()) {
      html = text(t.html);
      plain = htmlToText(html);
    } else if (t) {
      const blocks = composeEmail(t as { blocks?: EmailBlock[]; brandHeader?: boolean; brandFooter?: boolean }, (await this.brandKit(ctx, lookups)) as never);
      if (!blocks.length) throw new DeliveryError('EMPTY_TEMPLATE', `Template “${text(t.name)}” has no content.`);
      html = blocksToHtml(blocks, (t.design ?? {}) as Partial<EmailDesign>, subject, preview);
      plain = emailText(blocks);
    } else if (source.body?.trim()) {
      html = textToHtml(source.body, subject);
      plain = source.body;
    } else {
      throw new DeliveryError('NO_CONTENT', 'There is no template or message to send.');
    }
    const values = recipientValues(contact, {
      unsubscribe_url: contact ? `${publicApiUrl()}/unsubscribe/${unsubscribeToken(ctx.tenant.tenantId, contact.id)}` : '',
      ...extra,
    });
    if (!subject) throw new DeliveryError('NO_SUBJECT', 'The email has no subject line.');
    return {
      subject: personalize(subject, values, false),
      html: personalize(html, values, true),
      text: personalize(plain, values, false),
    };
  }

  private async content(ctx: HookContext, msg: Message, contact: Row | null, lookups: Lookups): Promise<Content> {
    if (msg.campaignId) {
      const campaign = await this.campaign(ctx, msg.campaignId, lookups);
      if (!campaign) throw new DeliveryError('CAMPAIGN_NOT_FOUND', 'The campaign was deleted.');
      if (['paused', 'cancelled'].includes(text(campaign.status)))
        throw new DeliveryError('CAMPAIGN_STOPPED', `The campaign is ${text(campaign.status)}.`);
      const template = campaign.templateId ? await this.template(ctx, text(campaign.templateId), lookups) : null;
      if (campaign.templateId && !template) throw new DeliveryError('TEMPLATE_NOT_FOUND', 'The campaign template was deleted.');
      return {
        ...(await this.render(ctx, { template, subject: text(campaign.subject), previewText: text(campaign.previewText), body: text(campaign.body) }, contact, {}, lookups)),
        marketing: true,
      };
    }
    const ref = msg.templateRef ?? '';
    const template = ref ? await this.template(ctx, ref, lookups) : null;
    if (!template) throw new DeliveryError('TEMPLATE_NOT_FOUND', ref ? `No email template named “${ref}”.` : 'The message has no template.');
    // Automation sends: run variables and trigger data fill {{vars.*}} and {{trigger.*}}.
    const extra: Record<string, string> = {};
    if (msg.runId) {
      const run = await ctx.store.findOrNull('executions', msg.runId);
      for (const [k, v] of Object.entries((run?.triggerData ?? {}) as Record<string, string>)) {
        extra[`trigger.${k}`] = v;
        extra[k.replace(/^(body|properties)\./, '')] ??= v;
      }
      for (const [k, v] of Object.entries((run?.variables ?? {}) as Record<string, string>)) extra[`vars.${k}`] = v;
    }
    return { ...(await this.render(ctx, { template }, contact, extra, lookups)), marketing: template.category !== 'transactional' };
  }

  // ---------- Accounts and senders ----------

  /** Connected email accounts with readable credentials, preferred first. */
  private async emailAccounts(ctx: HookContext, preferredId?: string | null) {
    const rows = (await ctx.store.all('channel-accounts', { channel: 'email' })).filter(
      (a) => a.status === 'connected' && typeof a._credentials === 'string' && providerOf(a.provider),
    );
    return rows.sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId) || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
  }

  private async account(ctx: HookContext, lookups: Lookups, campaign: Row | null) {
    if (lookups.account === undefined) {
      const [row] = await this.emailAccounts(ctx, text(campaign?.senderAccountId) || null);
      lookups.account = row
        ? { row, label: text(row.provider), sender: emailSender(providerOf(row.provider)!.key, open<Credentials>(text(row._credentials))) }
        : null;
    }
    if (!lookups.account)
      throw new DeliveryError('PROVIDER_NOT_CONNECTED', 'Connect an email account (SMTP, Amazon SES, Gmail or Outlook) in Channels → Email, then retry.');
    return lookups.account;
  }

  /** From and Reply-To: the mailbox for Gmail/Outlook, else the campaign's or default sender. */
  private async fromAddress(ctx: HookContext, lookups: Lookups, sender: EmailSender, campaign: Row | null) {
    lookups.senders ??= await ctx.store.all('email-senders');
    const label = text(campaign?.senderLabel);
    const chosen =
      lookups.senders.find((s) => label && (text(s.email) === emailOf(label) || text(s.name) === label)) ??
      lookups.senders.find((s) => s.isDefault) ??
      lookups.senders[0];
    const name = chosen ? text(chosen.name) : label.replace(/<[^>]*>/, '').trim();
    const address = sender.fixedFrom ?? (chosen ? text(chosen.email) : emailOf(label));
    if (!address) throw new DeliveryError('NO_SENDER', 'Add a sender address in Channels → Email → Senders.');
    const quoted = name ? `"${name.replace(/"/g, '')}" <${address}>` : address;
    return { from: quoted, replyTo: text(chosen?.replyTo) || (sender.fixedFrom && chosen ? text(chosen.email) : undefined) || undefined };
  }

  // ---------- Test sends and connection checks ----------

  /** Sends a rendered email right away (campaign and template tests). Throws 409/422 with a reason. */
  async sendTest(ctx: HookContext, recipients: string[], source: { template: Row | null; subject?: string | null; previewText?: string | null; body?: string }, campaign: Row | null) {
    const list = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (!list.length || list.some((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)))
      throw fieldError(422, 'INVALID_RECIPIENTS', 'recipients', 'Enter valid email addresses.');
    if (list.length > 10) throw fieldError(422, 'TOO_MANY_RECIPIENTS', 'recipients', 'Send tests to at most 10 addresses.');
    const lookups: Lookups = { templates: new Map(), campaigns: new Map() };
    try {
      const account = await this.account(ctx, lookups, campaign).catch((e: DeliveryError) => {
        throw fieldError(409, e.code, 'provider', e.message);
      });
      const from = await this.fromAddress(ctx, lookups, account.sender, campaign);
      for (const to of list) {
        const [match] = await ctx.store.em.query<{ id: string }[]>(
          `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'contacts' AND lower(data->>'email') = $2 LIMIT 1`,
          [ctx.store.tenantId, to],
        );
        const contact = match ? await ctx.store.findOrNull('contacts', match.id) : null;
        const content = await this.render(ctx, source, contact, {}, lookups).catch((e: DeliveryError) => {
          throw fieldError(422, e.code ?? 'RENDER_FAILED', 'content', e.message);
        });
        await account.sender
          .send({ ...from, to, subject: `[Test] ${content.subject}`, html: content.html, text: content.text })
          .catch((e) => {
            const r = describeSendError(e);
            throw fieldError(409, r.code, 'provider', `${account.label}: ${r.message}`);
          });
      }
      return { sent: list.length };
    } finally {
      lookups.account?.sender.close();
    }
  }

  /** Verifies an account's stored credentials with its provider. */
  async verifyAccount(account: Row): Promise<CheckResult> {
    const def = providerOf(account.provider);
    if (!def || typeof account._credentials !== 'string')
      return { ok: false, detail: 'No credentials stored. Reconnect the account.' };
    try {
      return await checkCredentials(def.key, open<Credentials>(account._credentials));
    } catch {
      return { ok: false, detail: 'Stored credentials cannot be read (the encryption key changed). Reconnect the account.' };
    }
  }
}

export type { OutgoingEmail };
