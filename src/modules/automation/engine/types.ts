/*
 * Ported from the frontend (types/automation.types.ts) so the API runs the exact workflow rules the
 * builder previews. Keep the two in sync until they move to a shared package.
 */
export interface Entity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type TriggerType =
  | 'contact_created'
  | 'added_to_list'
  | 'tag_added'
  | 'form_submitted'
  | 'message_received'
  | 'email_opened'
  | 'link_clicked'
  | 'deal_stage_changed'
  | 'date_attribute'
  | 'webhook'
  | 'incoming_webhook';

export type StepType =
  | 'send_email'
  | 'send_sms'
  | 'send_whatsapp'
  | 'delay'
  | 'wait_for_event'
  | 'wait_until'
  | 'condition'
  | 'ab_split'
  | 'update_contact'
  | 'set_variable'
  | 'add_tag'
  | 'remove_tag'
  | 'add_to_list'
  | 'create_task'
  | 'http_request'
  | 'assign_conversation'
  | 'goal'
  | 'if_else'
  | 'jump'
  | 'terminate'
  | 'slack_message'
  | 'teams_message'
  | 'google_sheets_row'
  | 'hubspot_sync'
  | 'shopify_customer'
  | 'zapier_trigger'
  | 'ai_generate';

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'is_set'
  | 'is_not_set';

/** One test inside a path, e.g. `{{contact.country}} equals Germany`. */
export interface PathCondition {
  id: string;
  /** Variable reference without braces: `contact.country`, `vars.order_status`, `trigger.list_id`. */
  variable: string;
  operator: ConditionOperator;
  /** May itself contain `{{…}}` references. */
  value: string;
}

/**
 * A branch out of a `condition` or `ab_split` step. Condition paths are checked
 * top to bottom; the first match wins and the `isElse` path catches the rest.
 * Split paths use `weight` (percent of contacts, all paths add up to 100).
 */
export interface WorkflowPath {
  id: string;
  label: string;
  match: 'all' | 'any';
  conditions: PathCondition[];
  weight?: number;
  isElse?: boolean;
  steps: WorkflowStep[];
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequestConfig {
  method: HttpMethod;
  url: string;
  headers: { id: string; key: string; value: string }[];
  /** JSON template; `{{…}}` references are replaced before sending. */
  body: string;
  timeoutSeconds: number;
  /** Save parts of the JSON response as workflow variables, e.g. `data.status` → `vars.order_status`. */
  saveResponse: { id: string; path: string; variable: string }[];
  /** What happens on a non-2xx response or timeout. */
  onError: 'continue' | 'stop';
}

export interface WorkflowStep {
  id: string;
  type: StepType;
  /** Simple settings per step type, e.g. `{ template }` or `{ amount: '2', unit: 'days' }`. */
  config: Record<string, string>;
  /** `condition` and `ab_split` steps. */
  paths?: WorkflowPath[];
  /** `http_request` steps. */
  http?: HttpRequestConfig;
  /** Custom name shown instead of the step type, e.g. “Reminder #2”. */
  name?: string;
  /** Internal note for your team; never sent. */
  note?: string;
  /** Turned-off steps are skipped (and logged) without being deleted. */
  disabled?: boolean;
}

export interface ConditionGroup {
  match: 'all' | 'any';
  conditions: PathCondition[];
}

/** Enrolment rules for the whole workflow. */
export interface WorkflowSettings {
  /** Only contacts matching these enter (no conditions = everyone the trigger fires for). */
  entry: ConditionGroup;
  /** Checked before every step; a match ends the run as `exited`. */
  exit: ConditionGroup;
  /** With re-entry on: days before the same contact can enter again. */
  reentryCooldownDays: number;
  /** Messages outside this window wait until it opens. Days: 0 = Sunday … 6 = Saturday. */
  sendWindow: { enabled: boolean; days: number[]; from: string; to: string };
}

/** Workflow-level variable, available to every step as `{{vars.key}}`. */
export interface WorkflowVariable {
  id: string;
  key: string;
  value: string;
  description: string;
}

/** The parts of a workflow that are versioned. */
export interface WorkflowDefinition {
  trigger: { type: TriggerType; config: Record<string, string> };
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  allowReentry: boolean;
  settings: WorkflowSettings;
}

/** An immutable published snapshot. New runs use the live version; running contacts keep theirs. */
export interface WorkflowVersion {
  version: number;
  publishedAt: string;
  publishedBy: string;
  note: string;
  definition: WorkflowDefinition;
}

export interface Workflow extends Entity, WorkflowDefinition {
  name: string;
  description: string;
  /** `draft` = never published. `active` runs the live version; `paused` enrols nobody. */
  status: 'active' | 'paused' | 'draft';
  /** Live version number, 0 before the first publish. The editable draft is the top-level definition. */
  version: number;
  versions: WorkflowVersion[];
  stats: {
    enrolled: number;
    active: number;
    completed: number;
    goalReached: number;
  };
}

export type ExecutionStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'goal_reached'
  | 'exited';

export type RunLogStatus =
  | 'success'
  | 'failed'
  | 'skipped'
  | 'waiting'
  | 'info';

/** One line of a run's log: what happened at a step and why. */
export interface RunLogEntry {
  id: string;
  /** Step id, or 'trigger' / 'system'. */
  stepId: string;
  stepType: StepType | 'trigger' | 'system';
  label: string;
  status: RunLogStatus;
  at: string;
  durationMs: number;
  message: string;
  detail?: {
    matchedPath?: string;
    evaluated?: { condition: string; actual: string; result: boolean }[];
    request?: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    response?: { status: number; body: string };
    variables?: Record<string, string>;
  };
}

/** One contact's journey through a workflow version ("execution" / "run"). */
export interface WorkflowExecution extends Entity {
  workflowId: string;
  version: number;
  contactId: string | null;
  contactName: string;
  status: ExecutionStatus;
  /** Step the run is on (waiting/running) or where it ended. */
  currentStepId: string | null;
  currentStep: string;
  startedAt: string;
  finishedAt: string | null;
  /** Waiting runs resume at this time. */
  resumeAt: string | null;
  /** `after`: continue after the current step (a finished wait). `at`: run the current step again (send window opened). */
  resumeMode?: 'after' | 'at';
  error: string | null;
  /** Test runs come from the builder: nothing is sent and delays are skipped. */
  test: boolean;
  variables: Record<string, string>;
  /** Path ids chosen at each branch, so the run can resume and be highlighted. */
  pathChoices: Record<string, string>;
  log: RunLogEntry[];
  /**
   * Backend only: the event a live "Wait for event" step is waiting for
   * (`email_opened`, `tag_added`…). Cleared when the run moves on.
   */
  waitingFor?: string | null;
  /** Backend only: the real trigger values, reused when the run resumes. */
  triggerData?: Record<string, string>;
}

export interface WorkflowRunStats {
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  /** Contacts currently on each step (running or waiting there). */
  onStep: Record<string, number>;
  /** Contacts that have passed through each step. */
  passed: Record<string, number>;
  /** Runs that failed at each step. */
  failedAt: Record<string, number>;
}
