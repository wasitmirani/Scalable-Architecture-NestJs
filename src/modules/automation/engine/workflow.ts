/*
 * Ported from the frontend (utils/helpers/workflow.ts) so the API runs the exact workflow rules the
 * builder previews. Keep the two in sync until they move to a shared package.
 */
import type {
  ConditionOperator,
  HttpRequestConfig,
  PathCondition,
  StepType,
  TriggerType,
  Workflow,
  WorkflowPath,
  WorkflowStep,
  WorkflowSettings,
  WorkflowVariable,
} from './types';
type Channel = 'email' | 'sms' | 'whatsapp' | 'push' | 'rcs' | 'voice';

const uid = () => crypto.randomUUID();

/** Where a new step goes: the list it lives in and the index. */
export interface InsertPoint {
  /** Id of the step owning the path, or null for the top level. */
  parentId: string | null;
  pathId: string | null;
  index: number;
}

export const newCondition = (
  variable = 'contact.country',
  operator: ConditionOperator = 'equals',
  value = '',
): PathCondition => ({ id: uid(), variable, operator, value });

export const newPath = (
  label: string,
  extra: Partial<WorkflowPath> = {},
): WorkflowPath => ({
  id: uid(),
  label,
  match: 'all',
  conditions: [],
  steps: [],
  ...extra,
});

export const defaultHttp = (): HttpRequestConfig => ({
  method: 'POST',
  url: '',
  headers: [{ id: uid(), key: 'Content-Type', value: 'application/json' }],
  body: '{\n  "email": "{{contact.email}}",\n  "first_name": "{{contact.first_name}}"\n}',
  timeoutSeconds: 10,
  saveResponse: [],
  onError: 'continue',
});

const DEFAULT_CONFIG: Partial<Record<StepType, Record<string, string>>> = {
  delay: { amount: '1', unit: 'days' },
  wait_for_event: {
    event: 'email_opened',
    timeoutAmount: '2',
    timeoutUnit: 'days',
  },
  wait_until: { days: '1,2,3,4,5', from: '09:00', to: '17:00' },
  jump: { target: '', maxLoops: '3' },
  terminate: { outcome: 'exited', reason: '' },
  google_sheets_row: { sheet: 'Sheet1' },
  hubspot_sync: { object: 'contact', mode: 'upsert' },
  shopify_customer: { lookup: 'email' },
  ai_generate: { style: 'friendly', variable: 'ai_message' },
};

export function createStep(
  type: StepType,
  config: Record<string, string> = {},
): WorkflowStep {
  const step: WorkflowStep = {
    id: uid(),
    type,
    config: Object.keys(config).length
      ? config
      : { ...(DEFAULT_CONFIG[type] ?? {}) },
  };
  if (type === 'condition')
    step.paths = [
      newPath('Path 1', { conditions: [newCondition()] }),
      newPath('Else', { isElse: true }),
    ];
  if (type === 'ab_split')
    step.paths = [newPath('A', { weight: 50 }), newPath('B', { weight: 50 })];
  // If / else: exactly two paths; the conditions live on Yes, No catches everyone else.
  if (type === 'if_else')
    step.paths = [
      newPath('Yes', { conditions: [newCondition()] }),
      newPath('No', { isElse: true }),
    ];
  // Fixed paths: the first is taken when the event happens, the second (else) when the timeout passes.
  if (type === 'wait_for_event')
    step.paths = [
      newPath('Event happened'),
      newPath('Timed out', { isElse: true }),
    ];
  if (type === 'http_request') step.http = defaultHttp();
  return step;
}

export const defaultSettings = (): WorkflowSettings => ({
  entry: { match: 'all', conditions: [] },
  exit: { match: 'any', conditions: [] },
  reentryCooldownDays: 0,
  sendWindow: {
    enabled: false,
    days: [1, 2, 3, 4, 5],
    from: '09:00',
    to: '20:00',
  },
});

/** Steps whose paths are fixed by the step type (no adding or removing paths). */
export const hasFixedPaths = (s: WorkflowStep) =>
  s.type === 'wait_for_event' || s.type === 'if_else';

/** Steps that never continue to the next one: End workflow and Go to step. */
export const isTerminal = (s: WorkflowStep) =>
  !s.disabled && (s.type === 'terminate' || s.type === 'jump');

/**
 * The branch steps (and the path taken in each) that lead to a step, outermost first,
 * so a jump can enter a path. Null when the step does not exist.
 */
export function pathTo(
  steps: WorkflowStep[],
  id: string,
): { stepId: string; pathId: string }[] | null {
  for (const s of steps) {
    if (s.id === id) return [];
    for (const p of s.paths ?? []) {
      const inner = pathTo(p.steps, id);
      if (inner) return [{ stepId: s.id, pathId: p.id }, ...inner];
    }
  }
  return null;
}

/** Shown on nodes and in logs: the custom name if set, else the step type. */
export const stepTitle = (s: WorkflowStep, typeLabel: string) =>
  s.name?.trim() || typeLabel;

/** Recursively rebuilds a tree, letting `fn` replace any step. */
function mapTree(
  steps: WorkflowStep[],
  fn: (s: WorkflowStep) => WorkflowStep,
): WorkflowStep[] {
  return steps.map((s) => {
    const mapped = fn(s);
    return mapped.paths
      ? {
          ...mapped,
          paths: mapped.paths.map((p) => ({
            ...p,
            steps: mapTree(p.steps, fn),
          })),
        }
      : mapped;
  });
}

/** Applies `fn` to the step list at the insert point. */
function editList(
  steps: WorkflowStep[],
  parentId: string | null,
  pathId: string | null,
  fn: (list: WorkflowStep[]) => WorkflowStep[],
): WorkflowStep[] {
  if (parentId === null) return fn(steps);
  return mapTree(steps, (s) =>
    s.id === parentId && s.paths
      ? {
          ...s,
          paths: s.paths.map((p) =>
            p.id === pathId ? { ...p, steps: fn(p.steps) } : p,
          ),
        }
      : s,
  );
}

export function insertStep(
  steps: WorkflowStep[],
  point: InsertPoint,
  step: WorkflowStep,
): WorkflowStep[] {
  return editList(steps, point.parentId, point.pathId, (list) => [
    ...list.slice(0, point.index),
    step,
    ...list.slice(point.index),
  ]);
}

export function removeStep(steps: WorkflowStep[], id: string): WorkflowStep[] {
  return steps
    .filter((s) => s.id !== id)
    .map((s) =>
      s.paths
        ? {
            ...s,
            paths: s.paths.map((p) => ({
              ...p,
              steps: removeStep(p.steps, id),
            })),
          }
        : s,
    );
}

/** Replaces fields of one step (config, http, paths…). */
export function updateStep(
  steps: WorkflowStep[],
  id: string,
  patch: Partial<WorkflowStep>,
): WorkflowStep[] {
  return mapTree(steps, (s) => (s.id === id ? { ...s, ...patch } : s));
}

export function findStep(
  steps: WorkflowStep[],
  id: string,
): WorkflowStep | null {
  for (const s of steps) {
    if (s.id === id) return s;
    for (const p of s.paths ?? []) {
      const found = findStep(p.steps, id);
      if (found) return found;
    }
  }
  return null;
}

export function countSteps(steps: WorkflowStep[]): number {
  return steps.reduce(
    (n, s) =>
      n + 1 + (s.paths ?? []).reduce((m, p) => m + countSteps(p.steps), 0),
    0,
  );
}

/** Every step in tree order (a branch's steps follow the step that owns it). */
export function flattenSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((s) => [
    s,
    ...(s.paths ?? []).flatMap((p) => flattenSteps(p.steps)),
  ]);
}

type DefinitionLike = Pick<
  Workflow,
  'trigger' | 'steps' | 'variables' | 'allowReentry' | 'settings'
>;

/** Stable key of everything a publish freezes, for draft-vs-live comparisons. */
export const definitionKey = (d: DefinitionLike) =>
  JSON.stringify([d.trigger, d.steps, d.variables, d.allowReentry, d.settings]);

/** True when the draft differs from the live (latest published) version. */
export function hasUnpublishedChanges(
  w: Pick<Workflow, 'versions'> & DefinitionLike,
): boolean {
  const live = w.versions[w.versions.length - 1];
  return !!live && definitionKey(w) !== definitionKey(live.definition);
}

/** Moves a step up or down within the list it belongs to. */
export function moveStep(
  steps: WorkflowStep[],
  id: string,
  dir: -1 | 1,
): WorkflowStep[] {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return steps;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }
  return steps.map((s) =>
    s.paths
      ? {
          ...s,
          paths: s.paths.map((p) => ({
            ...p,
            steps: moveStep(p.steps, id, dir),
          })),
        }
      : s,
  );
}

/** Position of a step in its list, for enabling move buttons. */
export function siblingInfo(
  steps: WorkflowStep[],
  id: string,
): { index: number; count: number } | null {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) return { index: i, count: steps.length };
  for (const s of steps) {
    for (const p of s.paths ?? []) {
      const found = siblingInfo(p.steps, id);
      if (found) return found;
    }
  }
  return null;
}

/** Deep copy with fresh ids everywhere: the step, its paths, their steps, conditions and HTTP rows. */
export function cloneStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    id: uid(),
    config: { ...step.config },
    http: step.http && {
      ...step.http,
      headers: step.http.headers.map((h) => ({ ...h, id: uid() })),
      saveResponse: step.http.saveResponse.map((r) => ({ ...r, id: uid() })),
    },
    paths: step.paths?.map((p) => ({
      ...p,
      id: uid(),
      conditions: p.conditions.map((c) => ({ ...c, id: uid() })),
      steps: p.steps.map(cloneStep),
    })),
  };
}

/** Copies a step (including every branch below it) right after the original. */
export function duplicateStep(
  steps: WorkflowStep[],
  id: string,
): { steps: WorkflowStep[]; newId: string | null } {
  let newId: string | null = null;
  const walk = (list: WorkflowStep[]): WorkflowStep[] => {
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) {
      const copy = cloneStep(list[i]);
      newId = copy.id;
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
    }
    return list.map((s) =>
      s.paths && !newId
        ? { ...s, paths: s.paths.map((p) => ({ ...p, steps: walk(p.steps) })) }
        : s,
    );
  };
  return { steps: walk(steps), newId };
}

type LegacyStep = Omit<WorkflowStep, 'type'> & {
  type: StepType | 'webhook';
  branches?: { yes: LegacyStep[]; no: LegacyStep[] };
};

/**
 * Upgrades steps saved in older formats: yes/no `branches` become paths, and
 * `webhook` steps become `http_request` steps.
 */
export function normalizeSteps(steps: LegacyStep[]): WorkflowStep[] {
  return steps.map((raw) => {
    const s = { ...raw };
    if (s.type === 'webhook') {
      s.type = 'http_request';
      s.http = {
        ...defaultHttp(),
        url: s.config.url ?? '',
        method: (s.config.method as HttpRequestConfig['method']) || 'POST',
      };
    }
    if (s.branches) {
      const cond = s.config.field
        ? [
            newCondition(
              `trigger.${s.config.field.toLowerCase().replace(/\W+/g, '_')}`,
              s.config.operator === 'is not' ? 'not_equals' : 'equals',
              s.config.value ?? '',
            ),
          ]
        : [newCondition()];
      s.paths = [
        newPath('Yes', {
          conditions: cond,
          steps: normalizeSteps(s.branches.yes),
        }),
        newPath('No', { isElse: true, steps: normalizeSteps(s.branches.no) }),
      ];
      delete s.branches;
    } else if (s.paths) {
      s.paths = s.paths.map((p) => ({
        ...p,
        steps: normalizeSteps(p.steps as LegacyStep[]),
      }));
    }
    return s as WorkflowStep;
  });
}

// ---------- variables ----------

export interface VariableOption {
  /** Reference without braces, e.g. `contact.first_name`. */
  ref: string;
  label: string;
  group: 'Contact' | 'Trigger' | 'Workflow variables' | 'From earlier steps';
}

export const CONTACT_VARIABLES: VariableOption[] = [
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['company', 'Company'],
  ['country', 'Country'],
  ['city', 'City'],
  ['lifecycle_stage', 'Lifecycle stage'],
  ['score', 'Lead score'],
  ['tags', 'Tags'],
  ['id', 'Contact ID'],
].map(([key, label]) => ({
  ref: `contact.${key}`,
  label,
  group: 'Contact' as const,
}));

export const TRIGGER_VARIABLES: Record<TriggerType, [string, string][]> = {
  contact_created: [['source', 'Source']],
  added_to_list: [
    ['list_id', 'List ID'],
    ['list_name', 'List name'],
  ],
  tag_added: [['tag', 'Tag']],
  form_submitted: [
    ['form_name', 'Form name'],
    ['page_url', 'Page URL'],
  ],
  message_received: [
    ['channel', 'Channel'],
    ['message_text', 'Message text'],
  ],
  email_opened: [['campaign_name', 'Campaign']],
  link_clicked: [
    ['url', 'Clicked URL'],
    ['campaign_name', 'Campaign'],
  ],
  deal_stage_changed: [
    ['deal_name', 'Deal'],
    ['stage', 'New stage'],
    ['value', 'Deal value'],
  ],
  date_attribute: [['date', 'Date']],
  webhook: [
    ['event', 'Event name'],
    ['occurred_at', 'Occurred at'],
    ['payload', 'Properties (JSON)'],
  ],
  incoming_webhook: [
    ['received_at', 'Received at'],
    ['request_id', 'Request ID'],
    ['payload', 'Raw body (JSON)'],
  ],
};

/** Short stable key for a step's outputs: `steps.<key>.status`. */
export const stepKey = (id: string) => id.replace(/-/g, '').slice(0, 8);

function outputsOf(s: WorkflowStep): VariableOption[] {
  if (s.type === 'http_request') {
    return [
      {
        ref: `steps.${stepKey(s.id)}.status`,
        label: 'HTTP status code',
        group: 'From earlier steps',
      },
      ...(s.http?.saveResponse ?? [])
        .filter((r) => r.variable)
        .map((r) => ({
          ref: `vars.${r.variable}`,
          label: `${r.variable} (HTTP response)`,
          group: 'From earlier steps' as const,
        })),
    ];
  }
  if (s.type === 'set_variable' && s.config.variable)
    return [
      {
        ref: `vars.${s.config.variable}`,
        label: `${s.config.variable} (set earlier)`,
        group: 'From earlier steps',
      },
    ];
  if (s.type === 'ai_generate' && s.config.variable)
    return [
      {
        ref: `vars.${s.config.variable}`,
        label: `${s.config.variable} (AI text)`,
        group: 'From earlier steps',
      },
    ];
  const out = (key: string, label: string): VariableOption => ({
    ref: `steps.${stepKey(s.id)}.${key}`,
    label,
    group: 'From earlier steps',
  });
  if (s.type === 'shopify_customer')
    return [
      out('orders_count', 'Shopify orders count'),
      out('total_spent', 'Shopify total spent'),
      out('customer_id', 'Shopify customer ID'),
    ];
  if (s.type === 'hubspot_sync') return [out('record_id', 'HubSpot record ID')];
  if (s.type === 'google_sheets_row') return [out('row', 'Sheet row number')];
  return [];
}

/** Variables a step can reference: contact, trigger, workflow variables and outputs of steps that run before it. */
export function variablesFor(
  workflow: {
    trigger: { type: TriggerType; config: Record<string, string> };
    steps: WorkflowStep[];
    variables: WorkflowVariable[];
  },
  stepId: string | null,
): VariableOption[] {
  const walk = (
    list: WorkflowStep[],
    acc: VariableOption[],
  ): VariableOption[] | null => {
    let scope = acc;
    for (const s of list) {
      if (s.id === stepId) return scope;
      for (const p of s.paths ?? []) {
        const found = walk(p.steps, [...scope, ...outputsOf(s)]);
        if (found) return found;
      }
      scope = [...scope, ...outputsOf(s)];
    }
    return stepId ? null : scope;
  };
  const earlier = walk(workflow.steps, []) ?? [];
  const seen = new Set<string>();
  return [
    ...triggerVariables(workflow.trigger),
    ...TRIGGER_VARIABLES[workflow.trigger.type].map(([key, label]) => ({
      ref: `trigger.${key}`,
      label,
      group: 'Trigger' as const,
    })),
    ...workflow.variables
      .filter((v) => v.key)
      .map((v) => ({
        ref: `vars.${v.key}`,
        label: v.description || v.key,
        group: 'Workflow variables' as const,
      })),
    ...earlier,
  ].filter((v) => {
    if (seen.has(v.ref)) return false;
    seen.add(v.ref);
    return true;
  });
}

// ---------- validation ----------

export interface WorkflowIssue {
  /** Step id, or 'trigger', 'variables' or 'settings'. */
  target: string;
  message: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const isVariableKey = (key: string) => KEY_RE.test(key);

/** Everything that must be fixed before the workflow can be activated. */
export function validateWorkflow(
  workflow: {
    trigger: { type: TriggerType; config: Record<string, string> };
    steps: WorkflowStep[];
    variables: WorkflowVariable[];
    settings?: WorkflowSettings;
  },
  meta: {
    triggerField: (
      type: TriggerType,
    ) => { key: string; label: string } | undefined;
    stepFields: (
      type: StepType,
    ) => { key: string; label: string; optional?: boolean }[];
    stepLabel: (type: StepType) => string;
  },
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const incomplete = (c: PathCondition) =>
    !c.variable ||
    (!['is_set', 'is_not_set'].includes(c.operator) && !c.value.trim());
  const st = workflow.settings;
  if (st) {
    if (st.entry.conditions.some(incomplete))
      issues.push({
        target: 'settings',
        message: 'Entry conditions: complete or remove each condition',
      });
    if (st.exit.conditions.some(incomplete))
      issues.push({
        target: 'settings',
        message: 'Exit conditions: complete or remove each condition',
      });
    if (
      st.sendWindow.enabled &&
      (st.sendWindow.days.length === 0 ||
        st.sendWindow.from >= st.sendWindow.to)
    )
      issues.push({
        target: 'settings',
        message:
          'Send window: choose days and an end time after the start time',
      });
  }
  issues.push(...triggerIssues(workflow.trigger));
  const tf = meta.triggerField(workflow.trigger.type);
  if (tf && !workflow.trigger.config[tf.key]?.trim())
    issues.push({
      target: 'trigger',
      message: `Trigger: choose ${tf.label.toLowerCase()}`,
    });
  if (workflow.steps.length === 0)
    issues.push({
      target: 'trigger',
      message: 'Add at least one step after the trigger',
    });

  const keys = workflow.variables.map((v) => v.key);
  workflow.variables.forEach((v) => {
    if (!KEY_RE.test(v.key))
      issues.push({
        target: 'variables',
        message: `Variable “${v.key || '(empty)'}”: use lowercase letters, digits and _`,
      });
    else if (keys.indexOf(v.key) !== keys.lastIndexOf(v.key))
      issues.push({
        target: 'variables',
        message: `Variable “${v.key}” is defined twice`,
      });
  });

  const all = flattenSteps(workflow.steps);
  const walk = (steps: WorkflowStep[]) => {
    for (const [i, s] of steps.entries()) {
      const label = stepTitle(s, meta.stepLabel(s.type));
      // Nothing after an End workflow or Go to step in the same list can run.
      if (isTerminal(s) && i < steps.length - 1)
        issues.push({
          target: steps[i + 1].id,
          message: `${stepTitle(steps[i + 1], meta.stepLabel(steps[i + 1].type))}: never runs, it comes after “${label}”`,
        });
      if (s.type === 'jump' && !s.disabled) {
        const target = all.find((x) => x.id === s.config.target);
        if (!target)
          issues.push({
            target: s.id,
            message: `${label}: choose the step to go to`,
          });
        else if (target.id === s.id)
          issues.push({
            target: s.id,
            message: `${label}: a step cannot go to itself`,
          });
        const loops = Number(s.config.maxLoops);
        if (!(loops >= 1 && loops <= 20))
          issues.push({
            target: s.id,
            message: `${label}: set a loop limit between 1 and 20`,
          });
      }
      // A turned-off step is skipped at run time, so its own settings cannot block publishing.
      if (s.disabled) {
        s.paths?.forEach((p) => walk(p.steps));
        continue;
      }
      if (s.type === 'wait_until') {
        if (!s.config.days?.trim())
          issues.push({
            target: s.id,
            message: `${label}: choose at least one day`,
          });
        if ((s.config.from ?? '') >= (s.config.to ?? ''))
          issues.push({
            target: s.id,
            message: `${label}: the end time must be after the start time`,
          });
      }
      if (s.type === 'wait_for_event' && !(Number(s.config.timeoutAmount) > 0))
        issues.push({
          target: s.id,
          message: `${label}: set a timeout greater than 0`,
        });
      for (const f of meta.stepFields(s.type)) {
        if (!f.optional && !s.config[f.key]?.trim())
          issues.push({
            target: s.id,
            message: `${label}: set ${f.label.toLowerCase()}`,
          });
      }
      if (
        s.type === 'set_variable' &&
        s.config.variable &&
        !KEY_RE.test(s.config.variable)
      )
        issues.push({
          target: s.id,
          message: `${label}: variable names use lowercase letters, digits and _`,
        });
      if (s.http) {
        const url = s.http.url.trim();
        // A URL may start with a variable such as {{vars.api_base}}; otherwise it must be https.
        if (
          !url ||
          !(/^https:\/\/\S+$/.test(url) || /^{{\s*[\w.]+\s*}}\S*$/.test(url))
        )
          issues.push({
            target: s.id,
            message: `${label}: enter an https:// URL`,
          });
        if (
          s.http.body.trim() &&
          ['POST', 'PUT', 'PATCH'].includes(s.http.method)
        ) {
          try {
            JSON.parse(s.http.body.replace(/{{[^}]+}}/g, '0'));
          } catch {
            issues.push({
              target: s.id,
              message: `${label}: the body is not valid JSON`,
            });
          }
        }
        if (
          s.http.saveResponse.some(
            (r) => !r.path.trim() || !KEY_RE.test(r.variable),
          )
        )
          issues.push({
            target: s.id,
            message: `${label}: complete each “save response” row`,
          });
      }
      if (s.paths) {
        if (s.type === 'condition' || s.type === 'if_else') {
          s.paths
            .filter((p) => !p.isElse)
            .forEach((p) => {
              if (
                p.conditions.length === 0 ||
                p.conditions.some(
                  (c) =>
                    !c.variable ||
                    (!['is_set', 'is_not_set'].includes(c.operator) &&
                      !c.value.trim()),
                )
              )
                issues.push({
                  target: s.id,
                  message: `${label}: complete the conditions of “${p.label}”`,
                });
            });
        }
        if (s.type === 'ab_split') {
          const total = s.paths.reduce((n, p) => n + (p.weight ?? 0), 0);
          if (total !== 100)
            issues.push({
              target: s.id,
              message: `${label}: path percentages add up to ${total}%, not 100%`,
            });
        }
        if (!hasFixedPaths(s) && s.paths.every((p) => p.steps.length === 0))
          issues.push({
            target: s.id,
            message: `${label}: add a step to at least one path`,
          });
        s.paths.forEach((p) => walk(p.steps));
      }
    }
  };
  walk(workflow.steps);
  return issues;
}

const SEND_CHANNEL: Partial<Record<StepType, Channel>> = {
  send_email: 'email',
  send_sms: 'sms',
  send_whatsapp: 'whatsapp',
};

/** Channels a workflow can message contacts on (enabled send steps), in first-use order. */
export function channelsOf(steps: WorkflowStep[]): Channel[] {
  return [
    ...new Set(
      flattenSteps(steps).flatMap((s) =>
        SEND_CHANNEL[s.type] && !s.disabled ? [SEND_CHANNEL[s.type]!] : [],
      ),
    ),
  ];
}

// ---------- webhook & event triggers ----------

/** Where payload fields live under `trigger.*` for each HTTP trigger. */
const PAYLOAD_PREFIX: Partial<Record<TriggerType, string>> = {
  incoming_webhook: 'body',
  webhook: 'properties',
};

const randomToken = (length: number) => {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

export const newWebhookToken = () => randomToken(24);
export const newWebhookSecret = () => `whsec_${randomToken(32)}`;

const SAMPLE_WEBHOOK_BODY = {
  email: 'olivia@example.com',
  first_name: 'Olivia',
  order: { id: 'ord_10482', total: 129.9, currency: 'USD' },
  source: 'shopify',
};
const SAMPLE_EVENT_PROPERTIES = { cart_id: 'cart_8f2k', total: 49.9, items: 3 };

/** Config a trigger starts with when it is picked. HTTP triggers get a fresh URL and secret. */
export function defaultTriggerConfig(
  type: TriggerType,
): Record<string, string> {
  if (type === 'incoming_webhook') {
    return {
      token: newWebhookToken(),
      auth: 'signature',
      secret: newWebhookSecret(),
      contactPath: 'email',
      matchBy: 'email',
      createContact: 'true',
      samplePayload: JSON.stringify(SAMPLE_WEBHOOK_BODY, null, 2),
    };
  }
  if (type === 'webhook')
    return {
      event: '',
      samplePayload: JSON.stringify(SAMPLE_EVENT_PROPERTIES, null, 2),
    };
  return {};
}

/** Parses a sample JSON payload; `value` is null when it is empty or invalid. */
export function parseSample(json: string | undefined): {
  value: Record<string, unknown> | null;
  error: string | null;
} {
  if (!json?.trim()) return { value: null, error: null };
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v))
      return {
        value: null,
        error: 'The body must be a JSON object, e.g. { "email": "…" }',
      };
    return { value: v as Record<string, unknown>, error: null };
  } catch (e) {
    return {
      value: null,
      error:
        e instanceof Error
          ? e.message.replace(/^JSON\.parse: /, '')
          : 'Invalid JSON',
    };
  }
}

/** Leaf fields of a JSON object as dotted paths: `order.total` → "129.9". Arrays use their first item. */
export function flattenPayload(
  obj: Record<string, unknown>,
  prefix = '',
  depth = 0,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const value: unknown = Array.isArray(v) ? (v as unknown[])[0] : v;
    if (Array.isArray(v) && depth < 4)
      out.push([`${path}_count`, String(v.length)]);
    if (value && typeof value === 'object' && depth < 4)
      out.push(
        ...flattenPayload(
          value as Record<string, unknown>,
          Array.isArray(v) ? `${path}.0` : path,
          depth + 1,
        ),
      );
    else out.push([path, value == null ? '' : String(value as string)]);
  }
  return out;
}

/** `trigger.*` variables: fixed ones plus every field of the sample payload of HTTP triggers. */
export function triggerVariables(trigger: {
  type: TriggerType;
  config: Record<string, string>;
}): VariableOption[] {
  const fixed = TRIGGER_VARIABLES[trigger.type].map(([key, label]) => ({
    ref: `trigger.${key}`,
    label,
    group: 'Trigger' as const,
  }));
  const prefix = PAYLOAD_PREFIX[trigger.type];
  const sample = prefix
    ? parseSample(trigger.config.samplePayload).value
    : null;
  if (!prefix || !sample) return fixed;
  return [
    ...fixed,
    ...flattenPayload(sample).map(([path, example]) => ({
      ref: `trigger.${prefix}.${path}`,
      label: example ? `${path} · e.g. ${example.slice(0, 24)}` : path,
      group: 'Trigger' as const,
    })),
  ];
}

/** Values for `trigger.*` from a sample payload, for test runs and demo data. */
export function samplePayloadValues(trigger: {
  type: TriggerType;
  config: Record<string, string>;
}): Record<string, string> {
  const prefix = PAYLOAD_PREFIX[trigger.type];
  const sample = prefix
    ? parseSample(trigger.config.samplePayload).value
    : null;
  if (!prefix || !sample) return {};
  return Object.fromEntries<string>([
    ...flattenPayload(sample).map(([k, v]): [string, string] => [
      `${prefix}.${k}`,
      v,
    ]),
    ['payload', JSON.stringify(sample)],
  ]);
}

const EVENT_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

function triggerIssues(trigger: {
  type: TriggerType;
  config: Record<string, string>;
}): WorkflowIssue[] {
  const c = trigger.config;
  const issues: WorkflowIssue[] = [];
  if (PAYLOAD_PREFIX[trigger.type]) {
    const { error } = parseSample(c.samplePayload);
    if (error)
      issues.push({
        target: 'trigger',
        message: `Trigger: sample payload is not valid JSON (${error})`,
      });
  }
  if (trigger.type === 'incoming_webhook') {
    if (!c.token)
      issues.push({
        target: 'trigger',
        message: 'Trigger: generate a webhook URL',
      });
    if (!c.contactPath?.trim())
      issues.push({
        target: 'trigger',
        message:
          'Trigger: choose the payload field that identifies the contact',
      });
    if (c.auth !== 'none' && !c.secret)
      issues.push({
        target: 'trigger',
        message: 'Trigger: generate a signing secret or turn verification off',
      });
  }
  if (
    trigger.type === 'webhook' &&
    c.event?.trim() &&
    !EVENT_RE.test(c.event.trim())
  )
    issues.push({
      target: 'trigger',
      message:
        'Trigger: event names use lowercase letters, digits, dots, - and _',
    });
  return issues;
}

/** Public origin of this API, used in incoming-webhook URLs. */
const apiOrigin = () =>
  (
    process.env.PUBLIC_API_URL ||
    process.env.APP_URL ||
    'http://localhost:8888'
  ).replace(/\/+$/, '');

/** Public URL of a workflow's incoming webhook. Mirrors `POST /hooks/workflows/{token}` in the API contract. */
export const webhookUrl = (token: string) =>
  `${apiOrigin()}/hooks/workflows/${token}`;
