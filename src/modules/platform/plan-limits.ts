import { HttpException, HttpStatus } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { HookContext } from '../records/collection.types';
import { text } from '../records/record-store';

/**
 * What each plan allows (package-wise limits). `null` means unlimited.
 * Matches the plan cards in PLANS (platform.service.ts) and the billing page.
 */
export type PlanId = 'free' | 'starter' | 'business' | 'enterprise';
export type Feature =
  | 'abTesting'
  | 'removeBranding'
  | 'segments'
  | 'salesCrm'
  | 'voice';

export interface Entitlements {
  contacts: number | null;
  emailsPerMonth: number | null;
  emailsPerDay: number | null;
  seats: number | null;
  activeAutomations: number | null;
  features: Record<Feature, boolean>;
}

const ALL_ON: Record<Feature, boolean> = {
  abTesting: true,
  removeBranding: true,
  segments: true,
  salesCrm: true,
  voice: true,
};

export const ENTITLEMENTS: Record<PlanId, Entitlements> = {
  free: {
    contacts: 1_000,
    emailsPerMonth: 9_000,
    emailsPerDay: 300,
    seats: 1,
    activeAutomations: 2,
    features: {
      abTesting: false,
      removeBranding: false,
      segments: false,
      salesCrm: false,
      voice: false,
    },
  },
  starter: {
    contacts: 10_000,
    emailsPerMonth: 20_000,
    emailsPerDay: null,
    seats: 3,
    activeAutomations: 10,
    features: {
      abTesting: true,
      removeBranding: true,
      segments: false,
      salesCrm: false,
      voice: false,
    },
  },
  business: {
    contacts: 50_000,
    emailsPerMonth: 250_000,
    emailsPerDay: null,
    seats: 10,
    activeAutomations: null,
    features: ALL_ON,
  },
  enterprise: {
    contacts: null,
    emailsPerMonth: null,
    emailsPerDay: null,
    seats: null,
    activeAutomations: null,
    features: ALL_ON,
  },
};

const PLAN_NAMES: Record<PlanId, string> = {
  free: 'Free',
  starter: 'Starter',
  business: 'Business',
  enterprise: 'Enterprise',
};
const ORDER: PlanId[] = ['free', 'starter', 'business', 'enterprise'];
const FEATURE_NAMES: Record<Feature, string> = {
  abTesting: 'A/B testing',
  removeBranding: 'Removing LinqFlow branding',
  segments: 'Segments',
  salesCrm: 'The sales CRM (companies, deals and pipelines)',
  voice: 'Voice and IVR',
};

/** The cheapest plan that passes `ok`, for the upgrade hint. */
function upgradeFor(ok: (e: Entitlements) => boolean): PlanId | null {
  return ORDER.find((p) => ok(ENTITLEMENTS[p])) ?? null;
}

/** 403 PLAN_LIMIT with the plan to upgrade to, which the UI turns into an upgrade prompt. */
export function planLimit(
  message: string,
  plan: PlanId,
  upgradeTo: PlanId | null,
  limit?: string,
) {
  return new HttpException(
    {
      message: upgradeTo
        ? `${message} Upgrade to ${PLAN_NAMES[upgradeTo]} to continue.`
        : message,
      error: 'Forbidden',
      code: 'PLAN_LIMIT',
      details: [{ field: 'plan', errors: [message] }],
      plan,
      upgradeTo,
      limit,
    },
    HttpStatus.FORBIDDEN,
  );
}

/** Plan of a workspace (Free until a subscription row exists). Works with any tenant-scoped manager. */
export async function planOf(
  em: EntityManager,
  tenantId: string,
): Promise<PlanId> {
  const [row] = await em.query<
    { plan: string | null; status: string | null }[]
  >(
    `SELECT data->>'planId' AS plan, data->>'status' AS status FROM product_records
      WHERE tenant_id = $1 AND collection = 'billing/subscription' LIMIT 1`,
    [tenantId],
  );
  const plan = (row?.plan ?? 'free') as PlanId;
  // A cancelled or unpaid subscription falls back to Free limits.
  if (row?.status && !['active', 'trialing'].includes(row.status))
    return 'free';
  return ENTITLEMENTS[plan] ? plan : 'free';
}

export async function entitlementsOf(ctx: HookContext) {
  const plan = await planOf(ctx.store.em, ctx.store.tenantId);
  return { plan, limits: ENTITLEMENTS[plan] };
}

export async function assertFeature(ctx: HookContext, feature: Feature) {
  const { plan, limits } = await entitlementsOf(ctx);
  if (!limits.features[feature])
    throw planLimit(
      `${FEATURE_NAMES[feature]} is not included in the ${PLAN_NAMES[plan]} plan.`,
      plan,
      upgradeFor((e) => e.features[feature]),
      feature,
    );
}

const count = async (ctx: HookContext, sql: string, params: unknown[] = []) => {
  const [r] = await ctx.store.em.query<{ n: string }[]>(sql, [
    ctx.store.tenantId,
    ...params,
  ]);
  return Number(r?.n) || 0;
};

/** Refuses creating `adding` contacts beyond the plan. Returns how many still fit. */
export async function contactCapacity(ctx: HookContext): Promise<number> {
  const { limits } = await entitlementsOf(ctx);
  if (limits.contacts === null) return Number.POSITIVE_INFINITY;
  const used = await count(
    ctx,
    `SELECT count(*) AS n FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'`,
  );
  return Math.max(0, limits.contacts - used);
}

export async function assertContactCapacity(ctx: HookContext, adding = 1) {
  const room = await contactCapacity(ctx);
  if (room >= adding) return;
  const { plan, limits } = await entitlementsOf(ctx);
  throw planLimit(
    `Your ${PLAN_NAMES[plan]} plan includes ${limits.contacts!.toLocaleString('en')} contacts${room ? ` (${room} left)` : ' and it is full'}.`,
    plan,
    upgradeFor((e) => e.contacts === null || e.contacts > limits.contacts!),
    'contacts',
  );
}

/** Emails sent (or being sent) this calendar month and today (UTC). */
export async function emailUsage(ctx: HookContext) {
  const now = new Date();
  const month = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const sql = `SELECT count(*) AS n FROM product_records WHERE tenant_id = $1 AND collection = 'messages'
    AND data->>'channel' = 'email' AND data->>'direction' = 'outbound' AND data->>'status' NOT IN ('queued', 'failed')
    AND (data->>'sentAt')::timestamptz >= $2`;
  return {
    month: await count(ctx, sql, [month]),
    day: await count(ctx, sql, [day]),
  };
}

/** Campaign launch: the whole audience must fit in this month's remaining emails. */
export async function assertEmailQuota(ctx: HookContext, adding: number) {
  const { plan, limits } = await entitlementsOf(ctx);
  if (limits.emailsPerMonth === null) return;
  const { month } = await emailUsage(ctx);
  const queued = await count(
    ctx,
    `SELECT count(*) AS n FROM product_records WHERE tenant_id = $1 AND collection = 'messages'
      AND data->>'channel' = 'email' AND data->>'status' = 'queued'`,
  );
  const left = limits.emailsPerMonth - month - queued;
  if (adding <= left) return;
  throw planLimit(
    `This send needs ${adding.toLocaleString('en')} emails but your ${PLAN_NAMES[plan]} plan has ${Math.max(0, left).toLocaleString('en')} left this month.`,
    plan,
    upgradeFor(
      (e) =>
        e.emailsPerMonth === null || e.emailsPerMonth > limits.emailsPerMonth!,
    ),
    'emails',
  );
}

/**
 * Worker check before each email: `ok`, `wait` (daily cap reached: retry tomorrow)
 * or `over` (monthly allowance used up).
 */
export async function emailAllowance(
  ctx: HookContext,
): Promise<
  | { state: 'ok' }
  | { state: 'wait'; until: string }
  | { state: 'over'; message: string }
> {
  const { plan, limits } = await entitlementsOf(ctx);
  if (limits.emailsPerMonth === null && limits.emailsPerDay === null)
    return { state: 'ok' };
  const used = await emailUsage(ctx);
  if (limits.emailsPerMonth !== null && used.month >= limits.emailsPerMonth)
    return {
      state: 'over',
      message: `The ${PLAN_NAMES[plan]} plan's ${limits.emailsPerMonth.toLocaleString('en')} emails for this month are used up. Upgrade, then retry.`,
    };
  if (limits.emailsPerDay !== null && used.day >= limits.emailsPerDay) {
    const now = new Date();
    return {
      state: 'wait',
      until: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      ).toISOString(),
    };
  }
  return { state: 'ok' };
}

export async function assertAutomationSlot(
  ctx: HookContext,
  workflowId: string,
) {
  const { plan, limits } = await entitlementsOf(ctx);
  if (limits.activeAutomations === null) return;
  const active = await count(
    ctx,
    `SELECT count(*) AS n FROM product_records WHERE tenant_id = $1 AND collection = 'workflows'
      AND data->>'status' = 'active' AND id <> $2::uuid`,
    [workflowId],
  );
  if (active < limits.activeAutomations) return;
  throw planLimit(
    `Your ${PLAN_NAMES[plan]} plan allows ${limits.activeAutomations} live automation${limits.activeAutomations === 1 ? '' : 's'}. Pause one first.`,
    plan,
    upgradeFor(
      (e) =>
        e.activeAutomations === null ||
        e.activeAutomations > limits.activeAutomations!,
    ),
    'automations',
  );
}

/** Seat check for invitations (members plus pending invitations). Uses the tenant manager directly. */
export async function assertSeat(em: EntityManager, tenantId: string) {
  const plan = await planOf(em, tenantId);
  const seats = ENTITLEMENTS[plan].seats;
  if (seats === null) return;
  const [r] = await em.query<{ n: string }[]>(
    `SELECT (SELECT count(*) FROM tenant_members WHERE tenant_id = $1)
          + (SELECT count(*) FROM invitations WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS n`,
    [tenantId],
  );
  if ((Number(r?.n) || 0) < seats) return;
  throw planLimit(
    `Your ${PLAN_NAMES[plan]} plan includes ${seats} seat${seats === 1 ? '' : 's'}, and they are all taken (including pending invitations).`,
    plan,
    upgradeFor((e) => e.seats === null || e.seats > seats),
    'seats',
  );
}

/** A downgrade must fit what the workspace already uses. */
export async function assertFitsPlan(ctx: HookContext, target: PlanId) {
  const t = ENTITLEMENTS[target];
  const problems: string[] = [];
  const contacts = await count(
    ctx,
    `SELECT count(*) AS n FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'`,
  );
  if (t.contacts !== null && contacts > t.contacts)
    problems.push(
      `${contacts.toLocaleString('en')} contacts (limit ${t.contacts.toLocaleString('en')})`,
    );
  const seats = await count(
    ctx,
    `SELECT count(*) AS n FROM tenant_members WHERE tenant_id = $1`,
  );
  if (t.seats !== null && seats > t.seats)
    problems.push(`${seats} members (limit ${t.seats})`);
  const autos = await count(
    ctx,
    `SELECT count(*) AS n FROM product_records WHERE tenant_id = $1 AND collection = 'workflows' AND data->>'status' = 'active'`,
  );
  if (t.activeAutomations !== null && autos > t.activeAutomations)
    problems.push(`${autos} live automations (limit ${t.activeAutomations})`);
  if (problems.length)
    throw planLimit(
      `To move to ${PLAN_NAMES[target]}, first reduce: ${problems.join(', ')}.`,
      target,
      null,
      'downgrade',
    );
}

export const planName = (p: string) => PLAN_NAMES[p as PlanId] ?? text(p);
