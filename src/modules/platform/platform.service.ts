import { Injectable } from '@nestjs/common';
import type { HookContext } from '../records/collection.types';
import {
  fieldError,
  invalidState,
  text,
  type Row,
} from '../records/record-store';
import { publicRow } from '../records/records.service';
import { newWebhookSecret } from './platform.collections';
import { assertFitsPlan, emailUsage, ENTITLEMENTS } from './plan-limits';

export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    description: 'Try every channel with a small audience.',
    features: [
      '300 emails / day',
      'Unified inbox (1 seat)',
      'Forms and lists',
      'Community support',
    ],
    limits: { contacts: 1_000, emails: 9_000, seats: 1 },
  },
  {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 29,
    description: 'Email and SMS marketing for growing teams.',
    features: [
      '20,000 emails / month',
      'SMS and WhatsApp (pay as you go)',
      'A/B testing',
      'Remove branding',
      '3 seats',
    ],
    limits: { contacts: 10_000, emails: 20_000, seats: 3 },
  },
  {
    id: 'business',
    name: 'Business',
    priceMonthly: 299,
    description: 'Automation, segmentation and the full inbox.',
    features: [
      '250,000 emails / month',
      'Automation workflows',
      'Advanced segments',
      'Sales CRM and pipelines',
      'Voice and IVR',
      '10 seats',
    ],
    limits: { contacts: 50_000, emails: 250_000, seats: 10 },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthly: null,
    description: 'Custom volumes, SSO, SLAs and a dedicated IP.',
    features: [
      'Custom volumes',
      'SSO and audit exports',
      'Dedicated IP and deliverability support',
      '99.95% uptime SLA',
      'Unlimited seats',
    ],
    limits: { contacts: null, emails: null, seats: null },
  },
] as const;

type PlanId = (typeof PLANS)[number]['id'];
const SERIES_CHANNELS = ['email', 'sms', 'whatsapp', 'voice'] as const;
const DAY = 86_400_000;

function nextRenewal(from = new Date()) {
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1),
  );
  return d.toISOString();
}

@Injectable()
export class PlatformService {
  // ---------- Webhooks ----------

  async deliveries(ctx: HookContext, endpointId?: string) {
    const page = await ctx.store.list(
      'webhook-deliveries',
      { searchFields: ['event'] },
      { filters: endpointId ? { endpointId } : {}, perPage: 50 },
    );
    return page.data;
  }

  async rotateSecret(ctx: HookContext, id: string) {
    const secret = newWebhookSecret();
    const endpoint = await ctx.store.patch('webhook-endpoints', id, {
      _secret: secret,
      secretPrefix: secret.slice(0, 10),
    });
    return { endpoint: publicRow(endpoint), secret };
  }

  /** Stores a delivery attempt and refreshes the endpoint's success rate. */
  async recordDelivery(
    ctx: HookContext,
    endpointId: string,
    delivery: Record<string, unknown>,
    existingId?: string,
  ) {
    const saved = existingId
      ? await ctx.store.patch('webhook-deliveries', existingId, delivery)
      : await ctx.store.insert('webhook-deliveries', {
          endpointId,
          ...delivery,
        });
    const recent = await this.deliveries(ctx, endpointId);
    const succeeded = recent.filter((d) => d.success).length;
    await ctx.store.patch('webhook-endpoints', endpointId, {
      lastDeliveryAt: new Date().toISOString(),
      successRate: recent.length ? succeeded / recent.length : 1,
    });
    return saved;
  }

  // ---------- Billing ----------

  /** One subscription per workspace; new workspaces start on Free. */
  async subscriptionRow(ctx: HookContext): Promise<Row> {
    const [row] = await ctx.store.all('billing/subscription');
    if (row) return row;
    return ctx.store.insert('billing/subscription', {
      planId: 'free',
      cycle: 'monthly',
      status: 'active',
      renewsAt: nextRenewal(),
      creditBalance: 0,
      paymentMethod: null,
    });
  }

  async subscription(ctx: HookContext) {
    const row = await this.subscriptionRow(ctx);
    const plan = PLANS.find((p) => p.id === row.planId) ?? PLANS[0];
    const periodStart = new Date(
      Date.parse(text(row.renewsAt)) - 31 * DAY,
    ).toISOString();
    const [usage] = await ctx.store.em.query<
      {
        contacts: string;
        email: string;
        sms: string;
        whatsapp: string;
        voice_seconds: string;
        seats: string;
      }[]
    >(
      `SELECT
         (SELECT count(*) FROM product_records WHERE tenant_id = $1 AND collection = 'contacts') AS contacts,
         (SELECT count(*) FROM product_records WHERE tenant_id = $1 AND collection = 'messages'
            AND data->>'channel' = 'email' AND data->>'direction' = 'outbound' AND created_at >= $2) AS email,
         (SELECT coalesce(sum(coalesce((data->>'segments')::int, 1)), 0) FROM product_records WHERE tenant_id = $1
            AND collection = 'messages' AND data->>'channel' = 'sms' AND data->>'direction' = 'outbound' AND created_at >= $2) AS sms,
         (SELECT count(DISTINCT data->>'to') FROM product_records WHERE tenant_id = $1 AND collection = 'messages'
            AND data->>'channel' = 'whatsapp' AND created_at >= $2) AS whatsapp,
         (SELECT coalesce(sum((data->>'durationSec')::int), 0) FROM product_records WHERE tenant_id = $1
            AND collection = 'calls' AND created_at >= $2) AS voice_seconds,
         (SELECT count(*) FROM tenant_members WHERE tenant_id = $1) AS seats`,
      [ctx.store.tenantId, periodStart],
    );
    const n = (v: string) => Number(v) || 0;
    const limits = ENTITLEMENTS[plan.id];
    const emails = await emailUsage(ctx);
    return {
      /** What the plan includes; the UI shows locks and upgrade prompts from this. */
      entitlements: {
        ...limits,
        emailsThisMonth: emails.month,
        emailsToday: emails.day,
      },
      planId: row.planId,
      cycle: row.cycle,
      status: row.status,
      renewsAt: row.renewsAt,
      seats: plan.limits.seats ?? n(usage.seats),
      creditBalance: Number(row.creditBalance) || 0,
      paymentMethod: row.paymentMethod ?? null,
      usage: [
        {
          key: 'contacts',
          label: 'Contacts',
          channel: null,
          used: n(usage.contacts),
          included: plan.limits.contacts,
          unit: 'contacts',
          overageRate: null,
        },
        {
          key: 'email',
          label: 'Emails',
          channel: 'email',
          used: n(usage.email),
          included: plan.limits.emails,
          unit: 'emails',
          overageRate: 0.0008,
        },
        {
          key: 'sms',
          label: 'SMS segments',
          channel: 'sms',
          used: n(usage.sms),
          included: null,
          unit: 'segments',
          overageRate: 0.0079,
        },
        {
          key: 'whatsapp',
          label: 'WhatsApp conversations',
          channel: 'whatsapp',
          used: n(usage.whatsapp),
          included: plan.id === 'free' ? 0 : 1_000,
          unit: 'conversations',
          overageRate: 0.0147,
        },
        {
          key: 'voice',
          label: 'Voice minutes',
          channel: 'voice',
          used: Math.ceil(n(usage.voice_seconds) / 60),
          included: plan.id === 'business' ? 2_000 : 0,
          unit: 'minutes',
          overageRate: 0.013,
        },
        {
          key: 'seats',
          label: 'Seats',
          channel: null,
          used: n(usage.seats),
          included: plan.limits.seats,
          unit: 'seats',
          overageRate: 25,
        },
      ],
    };
  }

  async changePlan(ctx: HookContext, planId: unknown, cycle: unknown) {
    const plan = PLANS.find((p) => p.id === planId);
    if (!plan) throw fieldError(422, 'INVALID_PLAN', 'planId', 'Pick a plan');
    if (plan.id === 'enterprise') {
      throw invalidState('Enterprise plans are arranged with sales.');
    }
    if (cycle !== 'monthly' && cycle !== 'yearly') {
      throw fieldError(
        422,
        'INVALID_CYCLE',
        'cycle',
        'Cycle must be monthly or yearly',
      );
    }
    const row = await this.subscriptionRow(ctx);
    // A downgrade must fit what the workspace already uses (contacts, seats, live automations).
    await assertFitsPlan(ctx, plan.id as PlanId);
    await ctx.store.patch('billing/subscription', row.id, {
      planId: plan.id as PlanId,
      cycle,
      status: 'active',
    });
    return this.subscription(ctx);
  }

  // ---------- Integrations & notifications ----------

  async connect(ctx: HookContext, id: string, account: unknown) {
    const name = text(account).trim();
    if (!name)
      throw fieldError(
        422,
        'REQUIRED',
        'account',
        'Enter the account to connect',
      );
    return ctx.store.patch('integrations', id, {
      status: 'connected',
      account: name.slice(0, 200),
      connectedBy: ctx.actorName,
      connectedAt: new Date().toISOString(),
    });
  }

  disconnect(ctx: HookContext, id: string) {
    return ctx.store.patch('integrations', id, {
      status: 'disconnected',
      account: null,
      connectedBy: null,
      connectedAt: null,
    });
  }

  async markAllRead(ctx: HookContext) {
    await ctx.store.em.query(
      `UPDATE product_records SET data = data || '{"read": true}'::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND collection = 'notifications' AND data->>'read' IS DISTINCT FROM 'true'`,
      [ctx.store.tenantId],
    );
  }

  // ---------- Analytics ----------

  /** Messaging, conversation, contact and revenue totals from the workspace's real data. */
  async overview(ctx: HookContext, daysInput: number) {
    const days = Math.min(Math.max(Math.floor(daysInput) || 30, 1), 365);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const from = new Date(today.getTime() - (days - 1) * DAY);
    const prevFrom = new Date(from.getTime() - days * DAY);
    const dates = Array.from({ length: days }, (_, i) =>
      new Date(from.getTime() + i * DAY).toISOString().slice(0, 10),
    );

    const t = ctx.store.tenantId;
    const daily = await ctx.store.em.query<
      {
        day: string;
        channel: string;
        sent: string;
        delivered: string;
        engaged: string;
        failed: string;
      }[]
    >(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, data->>'channel' AS channel,
              count(*) FILTER (WHERE data->>'status' NOT IN ('queued', 'failed', 'bounced')) AS sent,
              count(*) FILTER (WHERE data->>'status' IN ('delivered', 'read')) AS delivered,
              count(*) FILTER (WHERE data->>'status' = 'read'
                 OR data->'events' @> '[{"status":"opened"}]' OR data->'events' @> '[{"status":"clicked"}]') AS engaged,
              count(*) FILTER (WHERE data->>'status' IN ('failed', 'bounced')) AS failed
       FROM product_records
       WHERE tenant_id = $1 AND collection = 'messages' AND data->>'direction' = 'outbound' AND created_at >= $2
       GROUP BY 1, 2
       UNION ALL
       SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'voice', count(*),
              count(*) FILTER (WHERE data->>'status' = 'completed'),
              count(*) FILTER (WHERE data->>'status' = 'completed'),
              count(*) FILTER (WHERE data->>'status' IN ('no_answer', 'busy', 'failed'))
       FROM product_records WHERE tenant_id = $1 AND collection = 'calls' AND created_at >= $2
       GROUP BY 1`,
      [t, prevFrom.toISOString()],
    );
    const point = (channel: string, day: string) => {
      const r = daily.find((d) => d.channel === channel && d.day === day);
      return {
        date: day,
        sent: Number(r?.sent ?? 0),
        delivered: Number(r?.delivered ?? 0),
        engaged: Number(r?.engaged ?? 0),
        failed: Number(r?.failed ?? 0),
      };
    };
    const series = SERIES_CHANNELS.map((channel) => ({
      channel,
      points: dates.map((d) => point(channel, d)),
    }));
    const prevDates = Array.from({ length: days }, (_, i) =>
      new Date(prevFrom.getTime() + i * DAY).toISOString().slice(0, 10),
    );

    const totals = async (start: Date, end: Date, dayList: string[]) => {
      const sum = (k: 'sent' | 'delivered' | 'engaged' | 'failed') =>
        SERIES_CHANNELS.reduce(
          (n, ch) => n + dayList.reduce((m, d) => m + point(ch, d)[k], 0),
          0,
        );
      const [row] = await ctx.store.em.query<
        {
          conversations: string;
          contacts: string;
          revenue: string;
          first_response: string | null;
        }[]
      >(
        `SELECT
           (SELECT count(*) FROM product_records WHERE tenant_id = $1 AND collection = 'conversations'
              AND created_at >= $2 AND created_at < $3) AS conversations,
           (SELECT count(*) FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'
              AND created_at >= $2 AND created_at < $3) AS contacts,
           (SELECT coalesce(sum((data->>'value')::numeric), 0) FROM product_records WHERE tenant_id = $1
              AND collection = 'deals' AND data->>'status' = 'won'
              AND coalesce(data->>'closedAt', updated_at::text) >= $2::text
              AND coalesce(data->>'closedAt', updated_at::text) < $3::text) AS revenue,
           (SELECT avg(extract(epoch FROM (first_out - first_in)) / 60) FROM (
              SELECT min((data->>'at')::timestamptz) FILTER (WHERE data->>'direction' = 'inbound') AS first_in,
                     min((data->>'at')::timestamptz) FILTER (WHERE data->>'direction' = 'outbound' AND data->>'kind' = 'message') AS first_out
              FROM product_records WHERE tenant_id = $1 AND collection = 'conversation-messages'
                AND (data->>'at')::timestamptz >= $2 AND (data->>'at')::timestamptz < $3
              GROUP BY data->>'conversationId') r
            WHERE first_out > first_in) AS first_response`,
        [t, start.toISOString(), end.toISOString()],
      );
      return {
        sent: sum('sent'),
        delivered: sum('delivered'),
        engaged: sum('engaged'),
        failed: sum('failed'),
        conversations: Number(row.conversations),
        newContacts: Number(row.contacts),
        revenue: Number(row.revenue),
        avgFirstResponseMin: row.first_response
          ? Number(Number(row.first_response).toFixed(1))
          : 0,
      };
    };

    const tomorrow = new Date(today.getTime() + DAY);
    const growth = await ctx.store.em.query<{ day: string; total: string }[]>(
      `SELECT d::date::text AS day,
              (SELECT count(*) FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'
                 AND created_at < d + interval '1 day') AS total
       FROM generate_series($2::timestamptz, $3::timestamptz, interval '1 day') d`,
      [t, from.toISOString(), today.toISOString()],
    );

    return {
      period: { from: dates[0], to: dates[days - 1] },
      totals: await totals(from, tomorrow, dates),
      previous: await totals(prevFrom, from, prevDates),
      series,
      contactGrowth: growth.map((g) => ({
        date: g.day,
        value: Number(g.total),
      })),
    };
  }
}
