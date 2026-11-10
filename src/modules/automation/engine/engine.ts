/*
 * Ported from the frontend (api/mock/workflow-engine.ts) so the API runs the exact workflow rules the
 * builder previews. Keep the two in sync until they move to a shared package.
 */
import {
  INTEGRATION_APPS,
  STEP_TYPES,
  TRIGGERS,
  WAIT_EVENTS,
  type IntegrationApp,
} from './constants';
import type {
  ConditionGroup,
  PathCondition,
  RunLogEntry,
  RunLogStatus,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowStep,
} from './types';
/** The contact fields the engine reads; rows carry more. */
export type Contact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  consents: Record<string, string | undefined>;
  [key: string]: unknown;
};
import {
  findStep,
  pathTo,
  samplePayloadValues,
  stepKey,
  stepTitle,
} from './workflow';

/**
 * Reference workflow engine used by the demo API. It defines the behaviour the
 * backend engine must match: path selection, rejoining, variables, HTTP output
 * mapping, delays as durable waits, consent checks and error handling.
 */

const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return Math.abs(h);
}

export interface EngineContext {
  contact: Contact | null;
  trigger: Record<string, string>;
  vars: Record<string, string>;
  stepOutputs: Record<string, string>;
  attempt: number;
}

/** Resolves `contact.first_name`, `vars.x`, `trigger.y`, `steps.<key>.status`. */
export function resolve(ref: string, ctx: EngineContext): string {
  const [scope, ...rest] = ref.split('.');
  const key = rest.join('.');
  const c = ctx.contact;
  if (scope === 'contact') {
    if (!c) return '';
    const map: Record<string, unknown> = {
      first_name: c.firstName,
      last_name: c.lastName,
      email: c.email,
      phone: c.phone,
      company: c.companyName,
      country: c.country,
      city: c.city,
      lifecycle_stage: c.lifecycleStage,
      score: c.score,
      tags: c.tags.join(','),
      id: c.id,
      last_email_opened: String(hash(`${c.id}open`) % 100 < 45),
    };
    const value = key in map ? map[key] : c.attributes[key];
    return value == null ? '' : String(value as string);
  }
  if (scope === 'vars') return ctx.vars[key] ?? '';
  if (scope === 'trigger') return ctx.trigger[key] ?? '';
  if (scope === 'steps') return ctx.stepOutputs[key] ?? '';
  return '';
}

export const interpolate = (text: string, ctx: EngineContext) =>
  text.replace(/{{\s*([\w.]+)\s*}}/g, (_, ref: string) => resolve(ref, ctx));

function test(
  cond: PathCondition,
  ctx: EngineContext,
): { actual: string; result: boolean } {
  const actual = resolve(cond.variable, ctx);
  const expected = interpolate(cond.value, ctx);
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  const num = (v: string) => Number(v.replace(/[^0-9.-]/g, ''));
  const result = (() => {
    switch (cond.operator) {
      case 'equals':
        return a === e;
      case 'not_equals':
        return a !== e;
      case 'contains':
        return a.includes(e);
      case 'not_contains':
        return !a.includes(e);
      case 'greater_than':
        return actual !== '' && num(actual) > num(expected);
      case 'less_than':
        return actual !== '' && num(actual) < num(expected);
      case 'is_set':
        return actual !== '';
      case 'is_not_set':
        return actual === '';
    }
  })();
  return { actual: actual || '(empty)', result };
}

const OPERATOR_TEXT: Record<PathCondition['operator'], string> = {
  equals: '=',
  not_equals: '≠',
  contains: 'contains',
  not_contains: 'does not contain',
  greater_than: '>',
  less_than: '<',
  is_set: 'is set',
  is_not_set: 'is empty',
};

/** Evaluates an all/any condition group (entry and exit rules). */
function evaluateGroup(group: ConditionGroup, ctx: EngineContext) {
  const evaluated = group.conditions.map((c) => {
    const r = test(c, ctx);
    return {
      condition:
        `{{${c.variable}}} ${OPERATOR_TEXT[c.operator]} ${c.value}`.trim(),
      actual: r.actual,
      result: r.result,
    };
  });
  const results = evaluated.map((e) => e.result);
  return {
    match:
      group.match === 'all' ? results.every(Boolean) : results.some(Boolean),
    evaluated,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Is `ms` inside the window (local time of the workspace)? */
function inWindow(ms: number, days: number[], from: string, to: string) {
  const d = new Date(ms);
  return days.includes(d.getDay()) && hhmm(d) >= from && hhmm(d) < to;
}

/** Next moment the window opens after `ms`. */
function nextOpening(ms: number, days: number[], from: string): number {
  const [h, m] = from.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(ms);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > ms && days.includes(d.getDay())) return d.getTime();
  }
  return ms + 86_400_000;
}

const parseDays = (csv: string | undefined) =>
  (csv ?? '').split(',').filter(Boolean).map(Number);

/** Picks the path a contact takes at a branch or split, with an explanation for the log. */
function choosePath(
  step: WorkflowStep,
  ctx: EngineContext,
): {
  pathId: string | null;
  message: string;
  evaluated: NonNullable<RunLogEntry['detail']>['evaluated'];
} {
  const paths = step.paths ?? [];
  if (step.type === 'ab_split') {
    const roll = hash(`${ctx.contact?.id ?? 'anon'}:${step.id}`) % 100;
    let acc = 0;
    for (const p of paths) {
      acc += p.weight ?? 0;
      if (roll < acc)
        return {
          pathId: p.id,
          message: `Assigned to “${p.label}” (${p.weight}% of contacts)`,
          evaluated: [],
        };
    }
    return {
      pathId: paths[paths.length - 1]?.id ?? null,
      message: 'Assigned to the last path',
      evaluated: [],
    };
  }
  const evaluated: NonNullable<RunLogEntry['detail']>['evaluated'] = [];
  for (const p of paths.filter((x) => !x.isElse)) {
    const results = p.conditions.map((c) => {
      const r = test(c, ctx);
      evaluated.push({
        condition:
          `${p.label}: {{${c.variable}}} ${OPERATOR_TEXT[c.operator]} ${c.value}`.trim(),
        actual: r.actual,
        result: r.result,
      });
      return r.result;
    });
    const match =
      p.match === 'all' ? results.every(Boolean) : results.some(Boolean);
    if (match && results.length)
      return { pathId: p.id, message: `Matched “${p.label}”`, evaluated };
  }
  const fallback = paths.find((x) => x.isElse);
  return {
    pathId: fallback?.id ?? null,
    message: fallback
      ? `No path matched → “${fallback.label}”`
      : 'No path matched',
    evaluated,
  };
}

/** Steps in execution order, following (and recording) path choices. Paths rejoin into the parent list. */
function* walk(
  steps: WorkflowStep[],
  choose: (s: WorkflowStep) => string | null,
): Generator<WorkflowStep> {
  const stack: { list: WorkflowStep[]; i: number }[] = [{ list: steps, i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.list.length) {
      stack.pop();
      continue;
    }
    const s = top.list[top.i++];
    yield s;
    if (s.paths?.length) {
      const pathId = choose(s);
      const path = s.paths.find((p) => p.id === pathId);
      if (path) stack.push({ list: path.steps, i: 0 });
    }
  }
}

/** Fake but deterministic API response for the demo; field values follow the requested paths. */
function simulateHttp(
  step: WorkflowStep,
  ctx: EngineContext,
  url: string,
): { status: number; body: string; json: Record<string, unknown> | null } {
  const failRoll =
    hash(`${ctx.contact?.id ?? 'x'}:${step.id}:${ctx.attempt}`) % 100;
  if (failRoll < 9)
    return { status: 503, body: '{"error":"Service unavailable"}', json: null };
  const json: Record<string, unknown> = {};
  for (const r of step.http?.saveResponse ?? []) {
    const leafName = r.path.split('.').pop() ?? '';
    const value = /total|amount|price|value/.test(leafName)
      ? (40 + (hash(`${ctx.contact?.id}:${r.path}`) % 400)).toFixed(2)
      : /url|link/.test(leafName)
        ? `https://${new URL(url.startsWith('http') ? url : 'https://example.com').host}/checkout/${hash(ctx.contact?.id ?? '') % 100000}`
        : /status/.test(leafName)
          ? ['paid', 'pending', 'shipped'][hash(ctx.contact?.id ?? '') % 3]
          : `${leafName}-${hash(ctx.contact?.id ?? '') % 1000}`;
    // Build nested JSON from the dotted path.
    const parts = r.path.split('.');
    let node = json;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = (node[part] ??= {}) as Record<string, unknown>;
    });
  }
  if (Object.keys(json).length === 0) json.ok = true;
  return { status: 200, body: JSON.stringify(json, null, 2), json };
}

const readPath = (json: unknown, path: string): string => {
  const value = path
    .split('.')
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === 'object'
          ? (v as Record<string, unknown>)[k]
          : undefined,
      json,
    );
  return value == null
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value as string | number | boolean);
};

export interface ExecuteOptions {
  test: boolean;
  /** Clock the run starts at (ms). */
  now: number;
  /** Resume after this step (a finished delay) or from it (a retry). */
  resume?: { stepId: string; inclusive: boolean };
  /**
   * Backend addition: the real trigger values (`trigger.body.*` from an incoming
   * webhook…). Without it the engine uses sample values, as the builder preview does.
   */
  trigger?: Record<string, string>;
}

type RunState = Pick<
  WorkflowExecution,
  | 'status'
  | 'currentStepId'
  | 'currentStep'
  | 'resumeAt'
  | 'resumeMode'
  | 'finishedAt'
  | 'error'
  | 'variables'
  | 'pathChoices'
  | 'log'
>;

/** Runs a definition for one contact until it finishes, waits or fails. */
export function execute(
  def: WorkflowDefinition,
  run: Pick<RunState, 'variables' | 'pathChoices' | 'log'>,
  contact: Contact | null,
  opts: ExecuteOptions,
  attempt = 1,
): RunState {
  let clock = opts.now;
  const log = [...run.log];
  const pathChoices = { ...run.pathChoices };
  const settings = def.settings;
  const ctx: EngineContext = {
    contact,
    trigger: opts.trigger ?? sampleTrigger(def, contact),
    vars: { ...run.variables },
    stepOutputs: {},
    attempt,
  };
  const entry = (
    stepId: string,
    stepType: RunLogEntry['stepType'],
    label: string,
    status: RunLogStatus,
    message: string,
    durationMs = 20 + (hash(stepId + clock) % 180),
    detail?: RunLogEntry['detail'],
  ) => {
    log.push({
      id: crypto.randomUUID(),
      stepId,
      stepType,
      label,
      status,
      at: new Date(clock).toISOString(),
      durationMs,
      message,
      detail,
    });
    clock += durationMs;
  };
  /** Every exit point returns a complete state (resumeMode included, so stale values never leak). */
  const done = (
    status: RunState['status'],
    step: WorkflowStep | null,
    extra: Partial<RunState> = {},
  ): RunState => ({
    status,
    currentStepId: step?.id ?? null,
    currentStep: step
      ? stepTitle(step, STEP_TYPES[step.type].label)
      : 'Finished',
    resumeAt: null,
    resumeMode: 'after',
    finishedAt:
      status === 'waiting' || status === 'running'
        ? null
        : new Date(clock).toISOString(),
    error: null,
    variables: ctx.vars,
    pathChoices,
    log,
    ...extra,
  });

  if (!opts.resume) {
    ctx.vars = Object.fromEntries(def.variables.map((v) => [v.key, v.value]));
    entry(
      'trigger',
      'trigger',
      TRIGGERS[def.trigger.type].label,
      'info',
      opts.test
        ? 'Test run started from the builder'
        : `Entered: ${TRIGGERS[def.trigger.type].description}`,
      5,
      { variables: { ...ctx.trigger } },
    );
    if (settings?.entry.conditions.length) {
      const r = evaluateGroup(settings.entry, ctx);
      if (!r.match) {
        entry(
          'system',
          'system',
          'Entry conditions',
          'skipped',
          'Not enrolled: the contact does not meet the entry conditions',
          3,
          { evaluated: r.evaluated },
        );
        return done('exited', null, { currentStep: 'Not enrolled' });
      }
      entry(
        'system',
        'system',
        'Entry conditions',
        'success',
        'Entry conditions met',
        3,
        { evaluated: r.evaluated },
      );
    }
  } else {
    const resumed = findStep(def.steps, opts.resume.stepId);
    const message =
      attempt > 1
        ? `Retrying (attempt ${attempt})`
        : opts.resume.inclusive
          ? 'Send window opened, continuing'
          : resumed?.type === 'wait_for_event'
            ? pathChoices[resumed.id] === resumed.paths?.[0]?.id
              ? `Event happened: ${WAIT_EVENTS.find((e) => e.value === resumed.config.event)?.label.toLowerCase() ?? resumed.config.event}`
              : `Timed out after ${resumed.config.timeoutAmount} ${resumed.config.timeoutUnit}`
            : resumed?.type === 'wait_until'
              ? 'Time window opened, continuing'
              : 'Wait finished, continuing';
    entry('system', 'system', 'Resumed', 'info', message, 5);
  }

  /** Where walking starts doing work: a resume point, or the target of a jump. */
  let target = opts.resume ? { ...opts.resume } : null;
  let skipping = Boolean(target);
  const choose = (s: WorkflowStep) => {
    if (s.disabled) return null; // a turned-off branch is skipped together with its paths
    if (pathChoices[s.id]) return pathChoices[s.id];
    const choice = choosePath(s, ctx);
    pathChoices[s.id] = choice.pathId ?? '';
    if (!skipping)
      entry(
        s.id,
        s.type,
        stepTitle(s, STEP_TYPES[s.type].label),
        'success',
        choice.message,
        8,
        {
          matchedPath: choice.pathId ?? undefined,
          evaluated: choice.evaluated,
        },
      );
    return choice.pathId;
  };

  // A jump restarts the walk at its target, so the loop is labelled.
  flow: while (true) {
    for (const s of walk(def.steps, choose)) {
      const meta = STEP_TYPES[s.type];
      if (skipping) {
        if (s.id === target!.stepId) {
          skipping = false;
          if (!target!.inclusive) continue;
        } else {
          continue;
        }
      }
      const label = stepTitle(s, meta.label);
      // Exit conditions are checked before every step.
      if (settings?.exit.conditions.length) {
        const r = evaluateGroup(settings.exit, ctx);
        if (r.match) {
          entry(
            'system',
            'system',
            'Exit conditions',
            'info',
            `Exited before “${label}”: exit conditions met`,
            3,
            { evaluated: r.evaluated },
          );
          return done('exited', s);
        }
      }
      if (s.disabled) {
        entry(
          s.id,
          s.type,
          label,
          'skipped',
          s.paths
            ? 'Step is turned off: skipped with its paths'
            : 'Step is turned off: skipped',
          1,
        );
        continue;
      }
      if (s.type === 'wait_for_event') {
        const event =
          WAIT_EVENTS.find(
            (e) => e.value === s.config.event,
          )?.label.toLowerCase() ?? s.config.event;
        const [happened, timedOut] = s.paths ?? [];
        if (opts.test) {
          pathChoices[s.id] = happened?.id ?? '';
          entry(
            s.id,
            s.type,
            label,
            'skipped',
            `Test run: assumed the contact ${event} (took “${happened?.label}”)`,
            2,
          );
          continue;
        }
        const timeoutMs =
          Number(s.config.timeoutAmount || 0) *
          (UNIT_MS[s.config.timeoutUnit] ?? UNIT_MS.days);
        // Demo: about half of contacts do the event, at a random point before the timeout.
        const roll = hash(`${contact?.id ?? 'x'}:${s.id}:event`) % 100;
        const occurs = roll < 55;
        pathChoices[s.id] = (occurs ? happened?.id : timedOut?.id) ?? '';
        const after = occurs
          ? timeoutMs * (0.05 + (roll % 50) / 100)
          : timeoutMs;
        entry(
          s.id,
          s.type,
          label,
          'waiting',
          `Waiting up to ${s.config.timeoutAmount} ${s.config.timeoutUnit} until the contact ${event}`,
          2,
        );
        return done('waiting', s, {
          resumeAt: new Date(clock + after).toISOString(),
        });
      }
      if (s.paths) continue; // branch and split choices are logged by `choose`
      switch (s.type) {
        case 'delay': {
          const ms =
            Number(s.config.amount || 0) *
            (UNIT_MS[s.config.unit] ?? UNIT_MS.days);
          if (opts.test) {
            entry(
              s.id,
              s.type,
              label,
              'skipped',
              `Test run: skipped wait of ${s.config.amount} ${s.config.unit}`,
              2,
            );
            break;
          }
          entry(
            s.id,
            s.type,
            label,
            'waiting',
            `Waiting ${s.config.amount} ${s.config.unit}`,
            2,
          );
          return done('waiting', s, {
            resumeAt: new Date(clock + ms).toISOString(),
          });
        }
        case 'wait_until': {
          const days = parseDays(s.config.days);
          if (opts.test) {
            entry(
              s.id,
              s.type,
              label,
              'skipped',
              'Test run: skipped the time window',
              2,
            );
            break;
          }
          if (inWindow(clock, days, s.config.from, s.config.to)) {
            entry(
              s.id,
              s.type,
              label,
              'success',
              `Inside the window (${s.config.from}–${s.config.to}), continuing`,
              2,
            );
            break;
          }
          const opens = nextOpening(clock, days, s.config.from);
          entry(
            s.id,
            s.type,
            label,
            'waiting',
            `Outside the window; waiting until ${new Date(opens).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`,
            2,
          );
          return done('waiting', s, {
            resumeAt: new Date(opens).toISOString(),
          });
        }
        case 'send_email':
        case 'send_sms':
        case 'send_whatsapp': {
          const sw = settings?.sendWindow;
          if (
            sw?.enabled &&
            !opts.test &&
            !inWindow(clock, sw.days, sw.from, sw.to)
          ) {
            const opens = nextOpening(clock, sw.days, sw.from);
            entry(
              s.id,
              s.type,
              label,
              'waiting',
              `Held by the send window (${sw.from}–${sw.to}); sends at ${new Date(opens).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`,
              2,
            );
            return done('waiting', s, {
              resumeAt: new Date(opens).toISOString(),
              resumeMode: 'at',
            });
          }
          const channel =
            s.type === 'send_email'
              ? 'email'
              : s.type === 'send_sms'
                ? 'sms'
                : 'whatsapp';
          const address = channel === 'email' ? contact?.email : contact?.phone;
          if (!address)
            entry(
              s.id,
              s.type,
              label,
              'skipped',
              `Skipped: no ${channel === 'email' ? 'email address' : 'phone number'}`,
            );
          else if (contact?.blocklisted)
            entry(
              s.id,
              s.type,
              label,
              'skipped',
              'Skipped: contact is blocklisted',
            );
          else if (contact?.consents[channel] !== 'subscribed')
            entry(
              s.id,
              s.type,
              label,
              'skipped',
              `Skipped: no ${channel === 'email' ? 'email' : channel === 'sms' ? 'SMS' : 'WhatsApp'} consent`,
            );
          else
            entry(
              s.id,
              s.type,
              label,
              'success',
              opts.test
                ? `Test run: would send “${s.config.template}” to ${address}`
                : `Sent “${s.config.template}” to ${address}`,
              120 + (hash(s.id) % 300),
            );
          break;
        }
        case 'http_request': {
          const http = s.http!;
          const url = interpolate(http.url, ctx);
          const request = {
            method: http.method,
            url,
            headers: Object.fromEntries(
              http.headers
                .filter((h) => h.key)
                .map((h) => [
                  h.key,
                  /authorization|token|key|secret/i.test(h.key)
                    ? '••••••'
                    : interpolate(h.value, ctx),
                ]),
            ),
            body: ['POST', 'PUT', 'PATCH'].includes(http.method)
              ? interpolate(http.body, ctx)
              : '',
          };
          const res = simulateHttp(s, ctx, url);
          ctx.stepOutputs[`${stepKey(s.id)}.status`] = String(res.status);
          const duration = 90 + (hash(url + clock) % 700);
          if (res.status >= 400) {
            entry(
              s.id,
              s.type,
              label,
              'failed',
              `${http.method} ${url} → HTTP ${res.status}${http.onError === 'continue' ? ' (continuing)' : ''}`,
              duration,
              { request, response: { status: res.status, body: res.body } },
            );
            if (http.onError === 'stop') {
              return done('failed', s, {
                error: `${label}: HTTP ${res.status} from ${new URL(url.startsWith('http') ? url : 'https://invalid').host}`,
              });
            }
            break;
          }
          const saved: Record<string, string> = {};
          for (const r of http.saveResponse)
            if (r.variable)
              saved[r.variable] = ctx.vars[r.variable] = readPath(
                res.json,
                r.path,
              );
          entry(
            s.id,
            s.type,
            label,
            'success',
            `${http.method} ${url} → HTTP ${res.status}`,
            duration,
            {
              request,
              response: { status: res.status, body: res.body },
              variables: saved,
            },
          );
          break;
        }
        case 'set_variable': {
          const value = interpolate(s.config.value ?? '', ctx);
          ctx.vars[s.config.variable] = value;
          entry(
            s.id,
            s.type,
            label,
            'success',
            `vars.${s.config.variable} = “${value}”`,
            3,
            { variables: { [s.config.variable]: value } },
          );
          break;
        }
        case 'goal':
          entry(
            s.id,
            s.type,
            label,
            'success',
            `Goal reached: ${s.config.goal}`,
            3,
          );
          return done('goal_reached', s);
        case 'terminate': {
          const reason = s.config.reason?.trim()
            ? interpolate(s.config.reason, ctx)
            : 'End workflow step';
          entry(s.id, s.type, label, 'info', `Workflow ended: ${reason}`, 2);
          return done(
            s.config.outcome === 'completed' ? 'completed' : 'exited',
            s,
            { currentStep: `Ended · ${label}` },
          );
        }
        case 'jump': {
          const dest = findStep(def.steps, s.config.target);
          const route = dest ? pathTo(def.steps, dest.id) : null;
          const key = `jump:${s.id}`;
          const used = Number(pathChoices[key] || 0);
          const limit = Math.max(1, Number(s.config.maxLoops) || 3);
          if (!dest || !route) {
            entry(
              s.id,
              s.type,
              label,
              'failed',
              'The step to go to no longer exists',
            );
            return done('failed', s, {
              error: `${label}: target step is missing`,
            });
          }
          const destLabel = stepTitle(dest, STEP_TYPES[dest.type].label);
          if (used >= limit) {
            entry(
              s.id,
              s.type,
              label,
              'skipped',
              `Loop limit reached (${limit}×): not going back to “${destLabel}”; the run ends here`,
              2,
            );
            return done('completed', s, {
              currentStep: `Loop limit · ${label}`,
            });
          }
          pathChoices[key] = String(used + 1);
          // Re-decide every branch on the way, except the ones that lead into the target.
          for (const k of Object.keys(pathChoices))
            if (!k.startsWith('jump:')) delete pathChoices[k];
          for (const r of route) pathChoices[r.stepId] = r.pathId;
          entry(
            s.id,
            s.type,
            label,
            'success',
            `Going to “${destLabel}” (${used + 1} of ${limit})`,
            2,
          );
          target = { stepId: dest.id, inclusive: true };
          skipping = true;
          continue flow;
        }
        default: {
          if (meta.group === 'Integrations') {
            const r = runIntegration(s, label, ctx, opts.test);
            entry(
              s.id,
              s.type,
              label,
              r.ok ? 'success' : 'failed',
              r.message,
              150 + (hash(s.id + clock) % 500),
              r.detail,
            );
            if (!r.ok)
              return done('failed', s, { error: `${label}: ${r.message}` });
            break;
          }
          const text = meta.summary(s);
          entry(
            s.id,
            s.type,
            label,
            'success',
            opts.test
              ? `Test run: would ${label.toLowerCase()} (${interpolate(text, ctx)})`
              : `${label}: ${interpolate(text, ctx)}`,
          );
        }
      }
    }
    break;
  }
  entry(
    'system',
    'system',
    'Finished',
    'info',
    'Reached the end of the flow',
    1,
  );
  return done('completed', null);
}

/** Is an app connected? Set by the API layer; seeds assume every app is. */
let isConnected: (app: IntegrationApp) => boolean = () => true;
export const setConnectionCheck = (fn: (app: IntegrationApp) => boolean) => {
  isConnected = fn;
};

const AI_LINES: Record<string, string[]> = {
  friendly: [
    'Thanks so much, {name}! We’re thrilled to have you with us 💛',
    'Hi {name}, you made our day — your order is on its way!',
  ],
  professional: [
    'Thank you for your purchase, {name}. Your order is being prepared.',
    'Dear {name}, we appreciate your business and will keep you updated.',
  ],
  short: ['Thanks, {name}!', 'Got it, {name} — on its way.'],
};

/**
 * Simulated third-party call for integration steps. Fails like the real thing when the
 * app is not connected, so demo runs show the error and the retry flow.
 */
function runIntegration(
  s: WorkflowStep,
  label: string,
  ctx: EngineContext,
  test: boolean,
): { ok: boolean; message: string; detail?: RunLogEntry['detail'] } {
  const app = STEP_TYPES[s.type].app;
  const c = s.config;
  if (app) {
    if (!isConnected(app))
      return {
        ok: false,
        message: `${INTEGRATION_APPS[app].label} is not connected. Connect it, then retry this run.`,
      };
  }
  const pre = test ? 'Test run: would ' : '';
  const name = ctx.contact?.firstName ?? 'there';
  const out = (key: string, value: string) =>
    (ctx.stepOutputs[`${stepKey(s.id)}.${key}`] = value);
  switch (s.type) {
    case 'slack_message':
    case 'teams_message': {
      const text = interpolate(c.message ?? '', ctx);
      return {
        ok: true,
        message: `${test ? 'Test run: would post' : 'Posted'} to ${c.channel}: “${text.slice(0, 80)}”`,
        detail: {
          request: {
            method: 'POST',
            url:
              s.type === 'slack_message'
                ? 'slack://chat.postMessage'
                : 'teams://channel/messages',
            headers: {},
            body: JSON.stringify({ channel: c.channel, text }),
          },
        },
      };
    }
    case 'google_sheets_row': {
      const values = (c.values ?? '')
        .split(',')
        .map((v) => interpolate(v.trim(), ctx));
      const row = String(2 + (hash(`${ctx.contact?.id}${s.id}`) % 900));
      if (!test) out('row', row);
      return {
        ok: true,
        message: `${pre}${test ? 'add' : 'Added'} row ${test ? '' : `${row} `}to ${c.spreadsheet} › ${c.sheet || 'Sheet1'} (${values.length} columns)`,
        detail: {
          variables: test ? {} : { [`steps.${stepKey(s.id)}.row`]: row },
        },
      };
    }
    case 'hubspot_sync': {
      const recordId = String(
        10_000_000 + (hash(ctx.contact?.id ?? 'x') % 89_999_999),
      );
      out('record_id', recordId);
      return {
        ok: true,
        message: `${pre}${test ? (c.mode === 'create' ? 'create' : 'create or update') : c.mode === 'create' ? 'Created' : 'Synced'} HubSpot ${c.object || 'contact'} ${recordId}`,
        detail: {
          variables: { [`steps.${stepKey(s.id)}.record_id`]: recordId },
        },
      };
    }
    case 'shopify_customer': {
      const h = hash(`${ctx.contact?.id}shopify`);
      const values = {
        orders_count: String(h % 9),
        total_spent: ((h % 90_000) / 100).toFixed(2),
        customer_id: `gid://shopify/Customer/${7_000_000 + (h % 999_999)}`,
      };
      for (const [k, v] of Object.entries(values)) out(k, v);
      return {
        ok: true,
        message: `Found Shopify customer by ${c.lookup || 'email'}: ${values.orders_count} orders, $${values.total_spent} spent`,
        detail: {
          variables: Object.fromEntries(
            Object.entries(values).map(([k, v]) => [
              `steps.${stepKey(s.id)}.${k}`,
              v,
            ]),
          ),
        },
      };
    }
    case 'zapier_trigger':
      return {
        ok: true,
        message: `${test ? 'Test run: would send' : 'Sent'} contact and trigger data to ${(c.hookUrl ?? '').replace(/^https?:\/\//, '').split('/')[0] || 'the hook'} → 200`,
        detail: {
          request: {
            method: 'POST',
            url: c.hookUrl ?? '',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contact: { email: ctx.contact?.email },
              trigger: ctx.trigger,
              vars: ctx.vars,
            }).slice(0, 400),
          },
        },
      };
    case 'ai_generate': {
      const lines = AI_LINES[c.style] ?? AI_LINES.friendly;
      const text = lines[
        hash(`${ctx.contact?.id}${s.id}`) % lines.length
      ].replace('{name}', name);
      if (c.variable) ctx.vars[c.variable] = text;
      return {
        ok: true,
        message: `Wrote ${c.style || 'friendly'} text → vars.${c.variable}: “${text}”`,
        detail: { variables: c.variable ? { [c.variable]: text } : {} },
      };
    }
    default:
      return { ok: true, message: `${label}: done` };
  }
}

/** Plausible trigger payload so `{{trigger.*}}` has values in demo runs. */
function sampleTrigger(
  def: WorkflowDefinition,
  contact: Contact | null,
): Record<string, string> {
  const c = def.trigger.config;
  switch (def.trigger.type) {
    case 'added_to_list':
      return { list_id: c.listId ?? '', list_name: 'Newsletter subscribers' };
    case 'tag_added':
      return { tag: c.tag ?? '' };
    case 'form_submitted':
      return { form_name: c.form ?? '', page_url: 'https://northwind.io/demo' };
    case 'message_received':
      return {
        channel: c.channel ?? 'whatsapp',
        message_text: 'Hi, is this in stock?',
      };
    case 'webhook':
      return {
        event: c.event ?? '',
        occurred_at: new Date().toISOString(),
        payload: JSON.stringify({
          email: contact?.email,
          cart_id: `cart_${hash(contact?.id ?? '') % 9999}`,
        }),
        ...samplePayloadValues(def.trigger),
      };
    case 'incoming_webhook': {
      const values = samplePayloadValues(def.trigger);
      // The field that identifies the contact carries this contact's value, as a real request would.
      if (c.contactPath && contact)
        values[`body.${c.contactPath}`] =
          c.matchBy === 'phone'
            ? (contact.phone ?? '')
            : c.matchBy === 'id'
              ? contact.id
              : (contact.email ?? '');
      return {
        received_at: new Date().toISOString(),
        request_id: `req_${hash(`${contact?.id}${Date.now()}`).toString(36)}`,
        ...values,
      };
    }
    case 'deal_stage_changed':
      return {
        stage: c.stage ?? '',
        deal_name: 'Annual plan upgrade',
        value: '4800',
      };
    default:
      return {};
  }
}
