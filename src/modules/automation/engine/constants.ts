/*
 * Ported from the frontend (constants/automation.constants.ts) so the API runs the exact workflow rules the
 * builder previews. Keep the two in sync until they move to a shared package.
 */
import type { StepType, TriggerType, WorkflowStep } from './types';
type Tone = string;

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'template' | 'list' | 'textarea';
  options?: string[];
  /** For `template` fields: which channel's templates. */
  channel?: 'email' | 'sms' | 'whatsapp';
  placeholder?: string;
  /** Fields are required unless marked optional; missing values show as issues. */
  optional?: boolean;
  hint?: string;
  /** Display text for select options (value → label). */
  optionLabels?: Record<string, string>;
  /** Shows the {{ }} variable picker next to the input. */
  variables?: boolean;
}

export interface StepMeta {
  label: string;
  icon: string;
  tone: Tone;
  group: 'Messages' | 'Flow' | 'Contact' | 'Data & team' | 'Integrations';
  /** Third-party app the step needs a connection to. */
  app?: IntegrationApp;
  fields: ConfigField[];
  /** One-line summary shown on the node. */
  summary: (step: WorkflowStep) => string;
}

export type IntegrationApp =
  | 'slack'
  | 'teams'
  | 'google_sheets'
  | 'hubspot'
  | 'shopify'
  | 'zapier';

/** Apps that integration steps connect to. Connections live in `/integrations`. */
export const INTEGRATION_APPS: Record<
  IntegrationApp,
  { label: string; icon: string; description: string }
> = {
  slack: {
    label: 'Slack',
    icon: 'ri-slack-line',
    description: 'Post alerts to channels.',
  },
  teams: {
    label: 'Microsoft Teams',
    icon: 'ri-microsoft-line',
    description: 'Post to a team channel.',
  },
  google_sheets: {
    label: 'Google Sheets',
    icon: 'ri-file-excel-2-line',
    description: 'Append rows to a spreadsheet.',
  },
  hubspot: {
    label: 'HubSpot',
    icon: 'ri-contacts-book-2-line',
    description: 'Sync contacts and deals.',
  },
  shopify: {
    label: 'Shopify',
    icon: 'ri-shopping-bag-3-line',
    description: 'Read customers and orders.',
  },
  zapier: {
    label: 'Zapier / Make',
    icon: 'ri-flashlight-line',
    description: 'Hand off to thousands of other apps.',
  },
};

const TEAM = [
  'Contact owner',
  'Ayesha Raza',
  'Daniel Brooks',
  'Mei Lin',
  'Carlos Vega',
  'Hannah Becker',
];

/** Events a "Wait for event" step can listen for. */
export const WAIT_EVENTS = [
  { value: 'email_opened', label: 'Opens the previous email' },
  { value: 'email_clicked', label: 'Clicks a link' },
  { value: 'message_replied', label: 'Replies on any channel' },
  { value: 'form_submitted', label: 'Submits a form' },
  { value: 'order_placed', label: 'Places an order' },
  { value: 'tag_added', label: 'Gets a tag' },
];

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "1,2,3,4,5" → "Mon–Fri"; other sets are listed. */
export function dayNames(csv: string | undefined): string {
  const days = (csv ?? '').split(',').filter(Boolean).map(Number).sort();
  if (days.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (days.length === 7) return 'Every day';
  if (days.join() === '0,6') return 'Weekends';
  return days.map((d) => WEEKDAYS[d]).join(', ') || 'No days';
}

export const STEP_TYPES: Record<StepType, StepMeta> = {
  send_email: {
    label: 'Send email',
    icon: 'ri-mail-send-line',
    tone: 'primary',
    group: 'Messages',
    fields: [
      {
        key: 'template',
        label: 'Template',
        type: 'template',
        channel: 'email',
      },
    ],
    summary: ({ config }) => config.template || 'Choose a template',
  },
  send_sms: {
    label: 'Send SMS',
    icon: 'ri-message-2-line',
    tone: 'warning',
    group: 'Messages',
    fields: [
      { key: 'template', label: 'Template', type: 'template', channel: 'sms' },
    ],
    summary: ({ config }) => config.template || 'Choose a template',
  },
  send_whatsapp: {
    label: 'Send WhatsApp',
    icon: 'ri-whatsapp-line',
    tone: 'success',
    group: 'Messages',
    fields: [
      {
        key: 'template',
        label: 'Approved template',
        type: 'template',
        channel: 'whatsapp',
      },
    ],
    summary: ({ config }) => config.template || 'Choose a template',
  },
  delay: {
    label: 'Wait',
    icon: 'ri-time-line',
    tone: 'secondary',
    group: 'Flow',
    fields: [
      { key: 'amount', label: 'Wait for', type: 'number' },
      {
        key: 'unit',
        label: 'Unit',
        type: 'select',
        options: ['minutes', 'hours', 'days', 'weeks'],
      },
    ],
    summary: ({ config }) =>
      config.amount
        ? `${config.amount} ${config.unit || 'days'}`
        : 'Set a duration',
  },
  wait_for_event: {
    label: 'Wait for event',
    icon: 'ri-hourglass-2-line',
    tone: 'info',
    group: 'Flow',
    fields: [
      {
        key: 'event',
        label: 'Wait until the contact',
        type: 'select',
        options: WAIT_EVENTS.map((e) => e.value),
        optionLabels: Object.fromEntries(
          WAIT_EVENTS.map((e) => [e.value, e.label]),
        ),
      },
      { key: 'timeoutAmount', label: 'Give up after', type: 'number' },
      {
        key: 'timeoutUnit',
        label: 'Unit',
        type: 'select',
        options: ['hours', 'days', 'weeks'],
      },
    ],
    summary: ({ config }) =>
      `${WAIT_EVENTS.find((e) => e.value === config.event)?.label ?? 'Choose an event'} · max ${config.timeoutAmount || '?'} ${config.timeoutUnit || 'days'}`,
  },
  wait_until: {
    label: 'Time window',
    icon: 'ri-calendar-schedule-line',
    tone: 'secondary',
    group: 'Flow',
    fields: [],
    summary: ({ config }) =>
      `${dayNames(config.days)} · ${config.from || '?'}–${config.to || '?'}`,
  },
  condition: {
    label: 'Branch',
    icon: 'ri-git-branch-line',
    tone: 'info',
    group: 'Flow',
    fields: [],
    summary: ({ paths = [] }) => {
      const named = paths.filter((p) => !p.isElse);
      return named.length === 1
        ? `If ${named[0].label}, else…`
        : `${named.length} paths + else`;
    },
  },
  ab_split: {
    label: 'A/B split',
    icon: 'ri-shuffle-line',
    tone: 'pink',
    group: 'Flow',
    fields: [],
    summary: ({ paths = [] }) =>
      paths.map((p) => `${p.label} ${p.weight ?? 0}%`).join(' · '),
  },
  goal: {
    label: 'Goal',
    icon: 'ri-flag-line',
    tone: 'success',
    group: 'Flow',
    fields: [
      {
        key: 'goal',
        label: 'Contact exits when',
        type: 'text',
        placeholder: 'Places first order',
      },
    ],
    summary: ({ config }) => config.goal || 'Define the goal',
  },
  update_contact: {
    label: 'Update contact',
    icon: 'ri-user-settings-line',
    tone: 'secondary',
    group: 'Contact',
    fields: [
      {
        key: 'field',
        label: 'Field',
        type: 'select',
        options: ['lifecycleStage', 'ownerName', 'score', 'attributes.plan'],
      },
      { key: 'value', label: 'New value', type: 'text', variables: true },
    ],
    summary: ({ config }) =>
      config.field
        ? `${config.field} → ${config.value ?? ''}`
        : 'Choose a field',
  },
  add_tag: {
    label: 'Add tag',
    icon: 'ri-price-tag-3-line',
    tone: 'secondary',
    group: 'Contact',
    fields: [{ key: 'tag', label: 'Tag', type: 'text' }],
    summary: ({ config }) => config.tag || 'Choose a tag',
  },
  remove_tag: {
    label: 'Remove tag',
    icon: 'ri-price-tag-line',
    tone: 'secondary',
    group: 'Contact',
    fields: [{ key: 'tag', label: 'Tag', type: 'text' }],
    summary: ({ config }) => config.tag || 'Choose a tag',
  },
  add_to_list: {
    label: 'Add to list',
    icon: 'ri-list-check',
    tone: 'secondary',
    group: 'Contact',
    fields: [{ key: 'listId', label: 'List', type: 'list' }],
    summary: ({ config }) =>
      config.listId ? 'List selected' : 'Choose a list',
  },
  http_request: {
    label: 'HTTP request',
    icon: 'ri-global-line',
    tone: 'dark',
    group: 'Data & team',
    fields: [],
    summary: ({ http }) =>
      http?.url
        ? `${http.method} ${http.url.replace(/^https?:\/\//, '')}`
        : 'Set the URL',
  },
  set_variable: {
    label: 'Set variable',
    icon: 'ri-braces-line',
    tone: 'secondary',
    group: 'Data & team',
    fields: [
      {
        key: 'variable',
        label: 'Variable name',
        type: 'text',
        placeholder: 'order_status',
        hint: 'Later steps use it as {{vars.name}}.',
      },
      { key: 'value', label: 'Value', type: 'text', variables: true },
    ],
    summary: ({ config }) =>
      config.variable
        ? `vars.${config.variable} = ${config.value || '…'}`
        : 'Name the variable',
  },
  create_task: {
    label: 'Create task',
    icon: 'ri-task-line',
    tone: 'orange',
    group: 'Data & team',
    fields: [
      { key: 'title', label: 'Task', type: 'text', variables: true },
      {
        key: 'assignee',
        label: 'Assign to',
        type: 'select',
        optional: true,
        options: TEAM,
      },
    ],
    summary: ({ config }) => config.title || 'Describe the task',
  },
  assign_conversation: {
    label: 'Assign conversation',
    icon: 'ri-user-shared-line',
    tone: 'orange',
    group: 'Data & team',
    fields: [
      {
        key: 'team',
        label: 'Team',
        type: 'select',
        options: ['Support', 'Sales'],
      },
    ],
    summary: ({ config }) =>
      config.team ? `To ${config.team}` : 'Choose a team',
  },
  if_else: {
    label: 'If / else',
    icon: 'ri-guide-line',
    tone: 'info',
    group: 'Flow',
    fields: [],
    summary: ({ paths = [] }) => {
      const c = paths[0]?.conditions ?? [];
      return c.length
        ? `If ${c[0].variable} ${c[0].operator.replace(/_/g, ' ')} ${c[0].value}${c.length > 1 ? ` +${c.length - 1}` : ''}`.trim()
        : 'Set the condition';
    },
  },
  jump: {
    label: 'Go to step',
    icon: 'ri-corner-up-left-double-line',
    tone: 'dark',
    group: 'Flow',
    fields: [],
    summary: ({ config }) =>
      config.target
        ? `Jump · max ${config.maxLoops || 3}×`
        : 'Choose where to go',
  },
  terminate: {
    label: 'End workflow',
    icon: 'ri-stop-circle-line',
    tone: 'danger',
    group: 'Flow',
    fields: [
      {
        key: 'outcome',
        label: 'End the run as',
        type: 'select',
        options: ['exited', 'completed'],
        optionLabels: { exited: 'Exited (left early)', completed: 'Completed' },
      },
      {
        key: 'reason',
        label: 'Reason',
        type: 'text',
        optional: true,
        placeholder: 'Already a customer',
        hint: 'Shown in the run log.',
      },
    ],
    summary: ({ config }) =>
      `Ends here${config.reason ? ` · ${config.reason}` : ''}`,
  },
  slack_message: {
    label: 'Slack message',
    icon: 'ri-slack-line',
    tone: 'pink',
    group: 'Integrations',
    app: 'slack',
    fields: [
      {
        key: 'channel',
        label: 'Channel',
        type: 'text',
        placeholder: '#sales-alerts',
      },
      {
        key: 'message',
        label: 'Message',
        type: 'text',
        variables: true,
        placeholder:
          'New lead: {{contact.first_name}} from {{contact.company}}',
      },
    ],
    summary: ({ config }) =>
      config.channel ? `Post to ${config.channel}` : 'Choose a channel',
  },
  teams_message: {
    label: 'Microsoft Teams',
    icon: 'ri-microsoft-line',
    tone: 'primary',
    group: 'Integrations',
    app: 'teams',
    fields: [
      {
        key: 'channel',
        label: 'Team / channel',
        type: 'text',
        placeholder: 'Sales / Hot leads',
      },
      { key: 'message', label: 'Message', type: 'text', variables: true },
    ],
    summary: ({ config }) =>
      config.channel ? `Post to ${config.channel}` : 'Choose a channel',
  },
  google_sheets_row: {
    label: 'Google Sheets row',
    icon: 'ri-file-excel-2-line',
    tone: 'success',
    group: 'Integrations',
    app: 'google_sheets',
    fields: [
      {
        key: 'spreadsheet',
        label: 'Spreadsheet',
        type: 'text',
        placeholder: 'Leads 2026',
      },
      {
        key: 'sheet',
        label: 'Sheet',
        type: 'text',
        optional: true,
        placeholder: 'Sheet1',
      },
      {
        key: 'values',
        label: 'Columns (comma separated)',
        type: 'text',
        variables: true,
        placeholder: '{{contact.email}}, {{contact.first_name}}',
      },
    ],
    summary: ({ config }) =>
      config.spreadsheet
        ? `Add row to ${config.spreadsheet}${config.sheet ? ` › ${config.sheet}` : ''}`
        : 'Choose a spreadsheet',
  },
  hubspot_sync: {
    label: 'HubSpot sync',
    icon: 'ri-contacts-book-2-line',
    tone: 'orange',
    group: 'Integrations',
    app: 'hubspot',
    fields: [
      {
        key: 'object',
        label: 'Record',
        type: 'select',
        options: ['contact', 'deal'],
        optionLabels: { contact: 'Contact', deal: 'Deal' },
      },
      {
        key: 'mode',
        label: 'When it already exists',
        type: 'select',
        options: ['upsert', 'create'],
        optionLabels: { upsert: 'Update it', create: 'Create a new one' },
      },
    ],
    summary: ({ config }) =>
      `${config.mode === 'create' ? 'Create' : 'Create or update'} ${config.object || 'contact'}`,
  },
  shopify_customer: {
    label: 'Shopify customer',
    icon: 'ri-shopping-bag-3-line',
    tone: 'success',
    group: 'Integrations',
    app: 'shopify',
    fields: [
      {
        key: 'lookup',
        label: 'Find the customer by',
        type: 'select',
        options: ['email', 'phone'],
        optionLabels: { email: 'Email', phone: 'Phone' },
      },
    ],
    summary: ({ config }) =>
      `Look up by ${config.lookup || 'email'} · orders, total spent`,
  },
  zapier_trigger: {
    label: 'Zapier / Make',
    icon: 'ri-flashlight-line',
    tone: 'warning',
    group: 'Integrations',
    app: 'zapier',
    fields: [
      {
        key: 'hookUrl',
        label: 'Catch-hook URL',
        type: 'text',
        placeholder: 'https://hooks.zapier.com/hooks/catch/…',
        hint: 'Sends the contact, trigger data and variables as JSON.',
      },
    ],
    summary: ({ config }) =>
      config.hookUrl
        ? config.hookUrl.replace(/^https?:\/\//, '').slice(0, 34)
        : 'Paste the hook URL',
  },
  ai_generate: {
    label: 'AI: write text',
    icon: 'ri-sparkling-2-line',
    tone: 'pink',
    group: 'Integrations',
    fields: [
      {
        key: 'prompt',
        label: 'Instructions',
        type: 'text',
        variables: true,
        placeholder: 'Write a one-line thank-you for {{contact.first_name}}',
      },
      {
        key: 'style',
        label: 'Style',
        type: 'select',
        options: ['friendly', 'professional', 'short'],
        optionLabels: {
          friendly: 'Friendly',
          professional: 'Professional',
          short: 'Short and direct',
        },
      },
      {
        key: 'variable',
        label: 'Save as',
        type: 'text',
        placeholder: 'ai_message',
        hint: 'Later steps use it as {{vars.name}}.',
      },
    ],
    summary: ({ config }) =>
      config.variable
        ? `→ vars.${config.variable}`
        : 'Name the output variable',
  },
};

export type TriggerGroup = 'Contacts' | 'Engagement' | 'Sales' | 'Developers';

export interface TriggerMeta {
  label: string;
  icon: string;
  description: string;
  group: TriggerGroup;
  field?: ConfigField;
}

export const TRIGGER_GROUPS: {
  key: TriggerGroup;
  label: string;
  description: string;
}[] = [
  {
    key: 'Contacts',
    label: 'Contacts',
    description: 'Changes to a contact record',
  },
  {
    key: 'Engagement',
    label: 'Engagement',
    description: 'What contacts do with your messages and forms',
  },
  { key: 'Sales', label: 'Sales', description: 'Pipeline activity' },
  {
    key: 'Developers',
    label: 'Webhooks & API',
    description: 'Start from your own systems over HTTP',
  },
];

export const TRIGGERS: Record<TriggerType, TriggerMeta> = {
  contact_created: {
    label: 'Contact created',
    icon: 'ri-user-add-line',
    group: 'Contacts',
    description: 'A new contact is added in any way.',
  },
  added_to_list: {
    label: 'Added to a list',
    icon: 'ri-list-check',
    group: 'Contacts',
    description: 'A contact joins a list.',
    field: { key: 'listId', label: 'List', type: 'list' },
  },
  tag_added: {
    label: 'Tag added',
    icon: 'ri-price-tag-3-line',
    group: 'Contacts',
    description: 'A tag is added to a contact.',
    field: { key: 'tag', label: 'Tag', type: 'text' },
  },
  date_attribute: {
    label: 'Date reached',
    icon: 'ri-calendar-event-line',
    group: 'Contacts',
    description: 'Yearly on a date attribute, e.g. a birthday.',
    field: { key: 'attribute', label: 'Date attribute', type: 'text' },
  },
  form_submitted: {
    label: 'Form submitted',
    icon: 'ri-file-list-3-line',
    group: 'Engagement',
    description: 'A contact submits a signup form.',
    field: { key: 'form', label: 'Form name', type: 'text' },
  },
  message_received: {
    label: 'Message received',
    icon: 'ri-chat-download-line',
    group: 'Engagement',
    description: 'An inbound message arrives on a channel.',
    field: {
      key: 'channel',
      label: 'Channel',
      type: 'select',
      options: ['whatsapp', 'sms', 'email', 'livechat'],
    },
  },
  email_opened: {
    label: 'Email opened',
    icon: 'ri-mail-open-line',
    group: 'Engagement',
    description: 'A contact opens a campaign email.',
  },
  link_clicked: {
    label: 'Link clicked',
    icon: 'ri-cursor-line',
    group: 'Engagement',
    description: 'A contact clicks a tracked link.',
  },
  deal_stage_changed: {
    label: 'Deal stage changed',
    icon: 'ri-briefcase-line',
    group: 'Sales',
    description: 'A deal moves to another stage.',
    field: {
      key: 'stage',
      label: 'Stage',
      type: 'select',
      options: ['New', 'Qualified', 'Demo', 'Proposal', 'Negotiation'],
    },
  },
  incoming_webhook: {
    label: 'Incoming webhook',
    icon: 'ri-webhook-line',
    group: 'Developers',
    description:
      'Any system POSTs JSON to a unique URL generated for this automation.',
  },
  webhook: {
    label: 'Custom event (API)',
    icon: 'ri-code-s-slash-line',
    group: 'Developers',
    description:
      'Your backend tracks a named event for a contact through the Events API.',
    field: {
      key: 'event',
      label: 'Event name',
      type: 'text',
      placeholder: 'cart.abandoned',
      hint: 'Lowercase, dots or underscores, e.g. order.refunded.',
    },
  },
};

/** What each step does, shown in the step library and the inspector. */
export const STEP_DESCRIPTIONS: Record<StepType, string> = {
  send_email: 'Send an email from a template.',
  send_sms: 'Send a text message. Contacts without SMS consent are skipped.',
  send_whatsapp: 'Send an approved WhatsApp template.',
  delay: 'Pause before the next step. Waits survive restarts.',
  wait_for_event:
    'Hold contacts until they do something, with a timeout. Two paths follow: the event happened, or it timed out.',
  wait_until:
    'Continue only inside a time window, e.g. weekdays 09:00–17:00. Contacts outside it wait for the next opening.',
  condition:
    'Send contacts down different paths by conditions. Paths are checked in order; the first match wins.',
  ab_split: 'Split contacts randomly by percentage to test variations.',
  goal: 'Contacts who reach the goal leave the automation.',
  update_contact: 'Change a field on the contact.',
  add_tag: 'Add a tag to the contact.',
  remove_tag: 'Remove a tag from the contact.',
  add_to_list: 'Add the contact to a list.',
  http_request: 'Call any HTTP API, then use the response in later steps.',
  set_variable: 'Store a value for later steps, e.g. a computed status.',
  create_task: 'Create a follow-up task for your team.',
  assign_conversation: 'Route the open conversation to a team.',
  if_else:
    'Check a condition: contacts who match go down Yes, everyone else down No.',
  jump: 'Send the contact to another step, e.g. back to a reminder. Loops stop after the limit you set.',
  terminate:
    'Stop the workflow for this contact right here. Nothing after it runs.',
  slack_message:
    'Post a message to a Slack channel, with contact and trigger data.',
  teams_message: 'Post a message to a Microsoft Teams channel.',
  google_sheets_row: 'Append a row to a Google Sheet, one value per column.',
  hubspot_sync: 'Create or update the contact (or a deal) in HubSpot.',
  shopify_customer:
    'Look up the Shopify customer, then use their orders and spend in later steps.',
  zapier_trigger:
    'Send everything to a Zapier or Make catch hook to reach thousands of apps.',
  ai_generate:
    'Write personalised text with AI and save it to a variable for later messages.',
};

export const CONDITION_OPERATORS: {
  value: import('./types').ConditionOperator;
  label: string;
  needsValue: boolean;
}[] = [
  { value: 'equals', label: 'equals', needsValue: true },
  { value: 'not_equals', label: 'does not equal', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'greater_than', label: 'is greater than', needsValue: true },
  { value: 'less_than', label: 'is less than', needsValue: true },
  { value: 'is_set', label: 'is set', needsValue: false },
  { value: 'is_not_set', label: 'is empty', needsValue: false },
];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
