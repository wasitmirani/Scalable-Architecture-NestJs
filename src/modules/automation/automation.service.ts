import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { HookContext } from '../records/collection.types';
import {
  fieldError,
  invalidState,
  text,
  type ListQuery,
  type Row,
  type StoreChange,
} from '../records/record-store';
import { RecordsService } from '../records/records.service';
import {
  DISPATCHED_TYPES,
  dateAttribute,
  eventsFromChanges,
  matchesTrigger,
  waitEventOf,
  type TriggerEvent,
} from './automation-triggers';
import { INTEGRATION_APPS, STEP_TYPES, TRIGGERS } from './engine/constants';
import { definitionOf } from './engine/definition';
import { execute, setConnectionCheck, type Contact } from './engine/engine';
import type {
  StepType,
  Workflow,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowRunStats,
} from './engine/types';
import {
  defaultSettings,
  flattenPayload,
  normalizeSteps,
  findStep,
  parseSample,
  validateWorkflow,
} from './engine/workflow';

type WorkflowRow = Row & Workflow;
type RunRow = Row & WorkflowExecution;

const RUNS = 'executions';
const RUN_SHAPE = { searchFields: ['contactName'], defaultSort: 'startedAt' };
const DAY = 86_400_000;
const SEND_CHANNEL: Partial<Record<string, string>> = {
  send_email: 'email',
  send_sms: 'sms',
  send_whatsapp: 'whatsapp',
};

const issueMeta = {
  triggerField: (t: Workflow['trigger']['type']) => TRIGGERS[t].field,
  stepFields: (t: StepType) => STEP_TYPES[t].fields,
  stepLabel: (t: StepType) => STEP_TYPES[t].label,
};

/** Rows stored before variables, paths and versions existed are upgraded on read. */
export function upgrade<T extends Row>(w: T): T {
  const wf = w as unknown as WorkflowRow;
  return {
    ...w,
    variables: wf.variables ?? [],
    versions: wf.versions ?? [],
    settings: { ...defaultSettings(), ...wf.settings },
    steps: normalizeSteps(
      (wf.steps ?? []) as Parameters<typeof normalizeSteps>[0],
    ),
  };
}

/** Contact fields an `update_contact` step may set. */
const UPDATABLE = new Set([
  'firstName',
  'lastName',
  'phone',
  'jobTitle',
  'country',
  'city',
  'lifecycleStage',
  'ownerName',
]);

const DRAFT_FIELDS = [
  'name',
  'description',
  'trigger',
  'steps',
  'variables',
  'allowReentry',
  'settings',
];

@Injectable()
export class AutomationService implements OnModuleInit {
  private readonly logger = new Logger(AutomationService.name);

  // forwardRef: records.service → collections.registry → automation.collections → this file.
  constructor(
    @Inject(forwardRef(() => RecordsService))
    private readonly records: RecordsService,
  ) {}

  /** Contact and deal writes anywhere in the product start matching automations. */
  onModuleInit() {
    this.records.onChange((ctx, changes) => this.onRecordChanges(ctx, changes));
  }

  // ---------- Trigger dispatch ----------

  private async onRecordChanges(ctx: HookContext, changes: StoreChange[]) {
    const lists = new Map<string, string>();
    const pipelines = new Map<string, Row>();
    if (changes.some((c) => c.collection === 'contacts')) {
      for (const l of await ctx.store.all('lists'))
        lists.set(l.id, text(l.name));
    }
    if (changes.some((c) => c.collection === 'deals')) {
      for (const p of await ctx.store.all('pipelines')) pipelines.set(p.id, p);
    }
    const events = eventsFromChanges(changes, {
      listName: (id) => lists.get(id) ?? '',
      stageName: (pipelineId, stageId) => {
        const stages =
          (pipelines.get(pipelineId)?.stages as { id: string; name: string }[]) ??
          [...pipelines.values()].flatMap(
            (p) => (p.stages as { id: string; name: string }[]) ?? [],
          );
        return stages.find((s) => s.id === stageId)?.name ?? stageId;
      },
    });
    await this.dispatch(ctx, events);
  }

  /**
   * Fires one event that is not a record change: Events API, form submission,
   * inbound message, email open, link click. Contacts are looked up by id.
   */
  async fire(ctx: HookContext, event: TriggerEvent) {
    return this.dispatch(ctx, [event]);
  }

  /**
   * Enrols contacts in every live automation whose trigger matches, and moves
   * runs waiting for the event onto their "event happened" path.
   * Returns how many runs were started and resumed.
   */
  async dispatch(ctx: HookContext, events: TriggerEvent[]) {
    const result = { enrolled: 0, resumed: 0 };
    if (!events.length) return result;

    const live = (await ctx.store.all<WorkflowRow>('workflows', { status: 'active' }))
      .map((w) => ({ w, def: this.liveDefinition(w, w.version) }))
      .filter(
        (x): x is { w: WorkflowRow; def: WorkflowDefinition } =>
          !!x.def && DISPATCHED_TYPES.has(x.def.trigger.type),
      );
    const triggerTypes = new Set(live.map((x) => x.def.trigger.type));

    const waits = new Set(events.map(waitEventOf).filter(Boolean));
    const waiting = waits.size
      ? (await ctx.store.all<RunRow>(RUNS, { status: 'waiting', test: false })).filter(
          (r) => r.waitingFor && waits.has(r.waitingFor),
        )
      : [];
    if (!live.length && !waiting.length) return result;

    const contacts = new Map<string, (Row & Contact) | null>();
    const contactFor = async (id: string) => {
      if (!contacts.has(id)) contacts.set(id, await this.contactOf(ctx, id));
      return contacts.get(id)!;
    };

    for (const event of events) {
      if (triggerTypes.has(event.type)) {
        const contact = await contactFor(event.contactId);
        if (contact && !contact.blocklisted) {
          for (const { w, def } of live) {
            if (!matchesTrigger(def.trigger, event)) continue;
            const run = await this.enrol(ctx, w, contact, {
              ...event.values,
              occurred_at: event.values.occurred_at ?? new Date().toISOString(),
            });
            if (run) result.enrolled++;
          }
        }
      }

      const wait = waitEventOf(event);
      if (!wait) continue;
      for (const r of waiting) {
        if (r.contactId !== event.contactId || r.waitingFor !== wait) continue;
        const w = await ctx.store.findOrNull<WorkflowRow>('workflows', r.workflowId);
        const def = w && this.liveDefinition(w, r.version);
        const step = def && r.currentStepId ? findStep(def.steps, r.currentStepId) : null;
        const happened = step?.paths?.[0]?.id;
        if (!happened) continue;
        await ctx.store.patch(RUNS, r.id, {
          pathChoices: { ...r.pathChoices, [step.id]: happened },
          resumeAt: new Date().toISOString(),
          waitingFor: null,
        });
        r.waitingFor = null; // one event resumes a run once
        result.resumed++;
      }
    }
    if (result.resumed) await this.tick(ctx);
    if (result.enrolled || result.resumed)
      this.logger.log(
        `Workspace ${ctx.tenant.tenantId}: ${events.length} event(s) → ${result.enrolled} enrolled, ${result.resumed} resumed`,
      );
    return result;
  }

  /**
   * "Date reached" triggers (birthdays, renewals): enrols contacts whose date attribute
   * falls on today (UTC), once per contact per workflow per year. Safe to call often.
   */
  async dateTriggers(ctx: HookContext, today = new Date()) {
    const md = today.toISOString().slice(5, 10);
    const year = today.toISOString().slice(0, 4);
    const workflows = (await ctx.store.all<WorkflowRow>('workflows', { status: 'active' }))
      .map((w) => ({ w, def: this.liveDefinition(w, w.version) }))
      .filter((x) => x.def?.trigger.type === 'date_attribute' && x.def.trigger.config.attribute);
    if (!workflows.length) return 0;
    const contacts = await ctx.store.all<Row & Contact>('contacts');
    let enrolled = 0;
    for (const { w, def } of workflows) {
      const attribute = def!.trigger.config.attribute;
      const due = contacts.filter(
        (c) => !c.blocklisted && dateAttribute(c, attribute) === md,
      );
      if (!due.length) continue;
      const thisYear = new Set(
        (await ctx.store.all<RunRow>(RUNS, { workflowId: w.id, test: false }))
          .filter((r) => r.startedAt?.startsWith(year))
          .map((r) => r.contactId),
      );
      for (const c of due) {
        if (thisYear.has(c.id)) continue;
        const run = await this.enrol(
          ctx,
          w,
          c,
          { attribute, date: String(dateAttribute(c, attribute)), occurred_at: today.toISOString() },
          { ignoreReentry: true },
        );
        if (run) enrolled++;
      }
    }
    return enrolled;
  }

  /**
   * Runs the engine with this workspace's integration connections. `execute` is
   * synchronous, so the module-level connection check cannot leak between tenants.
   */
  private async engine(ctx: HookContext) {
    const integrations = await ctx.store.all('integrations', {
      status: 'connected',
    });
    const connected = new Set(integrations.map((i) => text(i.app)));
    return (...args: Parameters<typeof execute>) => {
      setConnectionCheck(
        (app) => connected.has(app) && app in INTEGRATION_APPS,
      );
      return execute(...args);
    };
  }

  private liveDefinition(
    w: WorkflowRow,
    version: number,
  ): WorkflowDefinition | null {
    return (
      (w.versions ?? []).find((v) => v.version === version)?.definition ?? null
    );
  }

  private contactOf(ctx: HookContext, id: string | null) {
    return id
      ? ctx.store.findOrNull<Row & Contact>('contacts', id)
      : Promise.resolve(null);
  }

  /** Message-log rows for send steps a live run just passed (delivery needs a provider). */
  private async queueSends(
    ctx: HookContext,
    def: WorkflowDefinition,
    run: RunRow,
    fromIndex: number,
    contact: (Row & Contact) | null,
  ) {
    if (run.test || !contact) return;
    const sends = run.log
      .slice(fromIndex)
      .filter((l) => l.status === 'success' && SEND_CHANNEL[l.stepType]);
    const rows = sends.map((l) => {
      const channel = SEND_CHANNEL[l.stepType]!;
      const step = findStep(def.steps, l.stepId);
      return {
        channel,
        direction: 'outbound',
        to: channel === 'email' ? contact.email : contact.phone,
        from: 'Automation',
        contactId: contact.id,
        contactName:
          `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || null,
        subject: l.label,
        preview: l.message.slice(0, 140),
        status: 'queued',
        provider: 'unassigned',
        segments: null,
        cost: 0,
        campaignId: null,
        campaignName: null,
        workflowId: run.workflowId,
        runId: run.id,
        // Delivery renders this template for the contact, with the run's trigger data.
        templateRef: step?.config?.template ?? null,
        errorCode: null,
        events: [
          {
            status: 'queued',
            at: l.at,
            detail: `Queued by automation step “${l.label}”`,
          },
        ],
      };
    });
    if (rows.length) await ctx.store.insertMany('messages', rows);
  }

  /**
   * Applies contact steps a live run just passed: the ported engine only logs them.
   * `update_contact` values containing {{variables}} are left to the engine's log.
   */
  private async applyContactSteps(
    ctx: HookContext,
    def: WorkflowDefinition,
    run: RunRow,
    fromIndex: number,
    contact: (Row & Contact) | null,
  ) {
    if (run.test || !contact) return;
    const steps = new Map<string, WorkflowDefinition['steps'][number]>();
    const walk = (list: WorkflowDefinition['steps']) => {
      for (const st of list) {
        steps.set(st.id, st);
        for (const path of st.paths ?? []) walk(path.steps ?? []);
      }
    };
    walk(def.steps);
    let tags = [...(contact.tags ?? [])];
    let listIds = [...((contact.listIds as string[]) ?? [])];
    const patch: Record<string, unknown> = {};
    for (const l of run.log.slice(fromIndex)) {
      const step = steps.get(l.stepId);
      if (l.status !== 'success' || !step) continue;
      const c = step.config ?? {};
      if (step.type === 'add_tag' && c.tag)
        tags = [...new Set([...tags, c.tag])];
      if (step.type === 'remove_tag' && c.tag)
        tags = tags.filter((t) => t !== c.tag);
      if (step.type === 'add_to_list' && c.listId)
        listIds = [...new Set([...listIds, c.listId])];
      if (
        step.type === 'update_contact' &&
        c.field &&
        !String(c.value ?? '').includes('{{')
      ) {
        if (c.field.startsWith('attributes.')) {
          patch.attributes = {
            ...(contact.attributes ?? {}),
            ...((patch.attributes as object) ?? {}),
            [c.field.slice(11)]: c.value ?? '',
          };
        } else if (UPDATABLE.has(c.field)) {
          patch[c.field] = c.value ?? null;
        }
      }
    }
    patch.tags = tags;
    patch.listIds = listIds;
    patch.lastActivityAt = new Date().toISOString();
    await ctx.store.patch('contacts', contact.id, patch);
  }

  private async afterSteps(
    ctx: HookContext,
    def: WorkflowDefinition,
    run: RunRow,
    fromIndex: number,
    contact: (Row & Contact) | null,
  ) {
    await this.queueSends(ctx, def, run, fromIndex, contact);
    await this.applyContactSteps(ctx, def, run, fromIndex, contact);
  }

  // ---------- Drafts, versions, state ----------

  async save(ctx: HookContext, id: string, body: unknown) {
    if (!body || typeof body !== 'object')
      throw fieldError(422, 'INVALID_BODY', 'body', 'Send the draft');
    const patch = Object.fromEntries(
      Object.entries(body).filter(([k]) => DRAFT_FIELDS.includes(k)),
    );
    if ('name' in patch && !text(patch.name).trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    return upgrade(await ctx.store.patch('workflows', id, patch));
  }

  async publish(ctx: HookContext, id: string, note: unknown) {
    const w = upgrade(await ctx.store.find<WorkflowRow>('workflows', id));
    const issues = validateWorkflow(w, issueMeta);
    if (issues.length) {
      throw new HttpException(
        {
          message: `Fix ${issues.length} issue(s) before publishing: ${issues[0].message}`,
          error: 'Unprocessable Entity',
          code: 'WORKFLOW_INVALID',
          details: issues.map((i) => ({
            field: i.target,
            errors: [i.message],
          })),
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const version = (w.version ?? 0) + 1;
    return upgrade(
      await ctx.store.patch('workflows', id, {
        status: 'active',
        version,
        versions: [
          ...w.versions,
          {
            version,
            publishedAt: new Date().toISOString(),
            publishedBy: ctx.actorName,
            note: text(note).trim().slice(0, 500) || `Version ${version}`,
            definition: definitionOf(w),
          },
        ],
      }),
    );
  }

  async pause(ctx: HookContext, id: string) {
    const w = await ctx.store.find<WorkflowRow>('workflows', id);
    if (w.status !== 'active')
      throw invalidState('Only live automations can be paused.');
    return upgrade(
      await ctx.store.patch('workflows', id, { status: 'paused' }),
    );
  }

  async resume(ctx: HookContext, id: string) {
    const w = await ctx.store.find<WorkflowRow>('workflows', id);
    if (!w.version) {
      throw new HttpException(
        {
          message: 'Publish the workflow before resuming it.',
          error: 'Conflict',
          code: 'NOT_PUBLISHED',
        },
        HttpStatus.CONFLICT,
      );
    }
    const updated = upgrade(
      await ctx.store.patch('workflows', id, { status: 'active' }),
    );
    await this.tick(ctx); // held runs whose time passed continue now
    return updated;
  }

  /** Copies a published version into the draft; the live version is untouched until publish. */
  async restoreVersion(ctx: HookContext, id: string, version: number) {
    const w = upgrade(await ctx.store.find<WorkflowRow>('workflows', id));
    const v = w.versions.find((x) => x.version === version);
    if (!v)
      throw new HttpException(
        { message: 'Version not found', error: 'Not Found', code: 'NOT_FOUND' },
        404,
      );
    return upgrade(
      await ctx.store.patch(
        'workflows',
        id,
        structuredClone(v.definition) as unknown as Record<string, unknown>,
      ),
    );
  }

  // ---------- Runs ----------

  /**
   * Durable delays: resumes waiting runs whose time has come, in time order.
   * Called before run reads and by the background poller (AutomationScheduler).
   */
  async tick(ctx: HookContext) {
    const now = Date.now();
    const due = (
      await ctx.store.all<RunRow>(RUNS, { status: 'waiting', test: false })
    ).filter((r) => r.resumeAt && Date.parse(r.resumeAt) <= now);
    if (!due.length) return 0;
    const run = await this.engine(ctx);
    const workflows = new Map<string, WorkflowRow>();
    let resumed = 0;
    for (const r of due) {
      const w =
        workflows.get(r.workflowId) ??
        (await ctx.store.findOrNull<WorkflowRow>('workflows', r.workflowId));
      if (!w) continue;
      workflows.set(w.id, w);
      const def = this.liveDefinition(w, r.version);
      if (w.status !== 'active' || !def) continue; // paused workflows hold their runs
      const contact = await this.contactOf(ctx, r.contactId);
      const resumeOf = (
        x: Pick<WorkflowExecution, 'currentStepId' | 'resumeMode'>,
      ) => ({
        stepId: x.currentStepId!,
        inclusive: x.resumeMode === 'at',
      });
      const before = r.log.length;
      const live = { trigger: r.triggerData, liveEvents: true };
      let state = run(def, r, contact, {
        test: false,
        now: Date.parse(r.resumeAt!),
        resume: resumeOf(r),
        ...live,
      });
      while (
        state.status === 'waiting' &&
        state.resumeAt &&
        Date.parse(state.resumeAt) <= now
      ) {
        state = run(def, state, contact, {
          test: false,
          now: Date.parse(state.resumeAt),
          resume: resumeOf(state),
          ...live,
        });
      }
      const saved = await ctx.store.patch<RunRow>(
        RUNS,
        r.id,
        state as unknown as Record<string, unknown>,
      );
      await this.afterSteps(ctx, def, saved, before, contact);
      resumed++;
    }
    return resumed;
  }

  async runs(ctx: HookContext, q: ListQuery, workflowId?: string) {
    await this.tick(ctx);
    const { test, ...filters } = q.filters ?? {};
    const testFilter: Record<string, string> =
      test === 'include' ? {} : { test: test === 'only' ? 'true' : 'false' };
    return ctx.store.list(RUNS, RUN_SHAPE, {
      ...q,
      sort: 'startedAt',
      order: 'desc',
      filters: {
        ...filters,
        ...testFilter,
        ...(workflowId ? { workflowId } : {}),
      },
    });
  }

  async run(ctx: HookContext, runId: string) {
    await this.tick(ctx);
    return ctx.store.find(RUNS, runId);
  }

  async stats(
    ctx: HookContext,
    workflowId: string,
    runs?: RunRow[],
  ): Promise<WorkflowRunStats> {
    const rows =
      runs ?? (await ctx.store.all<RunRow>(RUNS, { workflowId, test: false }));
    const onStep: Record<string, number> = {};
    const passed: Record<string, number> = {};
    const failedAt: Record<string, number> = {};
    for (const r of rows) {
      if (
        (r.status === 'waiting' || r.status === 'running') &&
        r.currentStepId
      ) {
        onStep[r.currentStepId] = (onStep[r.currentStepId] ?? 0) + 1;
      }
      if (r.status === 'failed' && r.currentStepId)
        failedAt[r.currentStepId] = (failedAt[r.currentStepId] ?? 0) + 1;
      for (const stepId of new Set(
        r.log.filter((l) => l.status !== 'waiting').map((l) => l.stepId),
      )) {
        passed[stepId] = (passed[stepId] ?? 0) + 1;
      }
    }
    const count = (...s: WorkflowExecution['status'][]) =>
      rows.filter((r) => s.includes(r.status)).length;
    return {
      running: count('running'),
      waiting: count('waiting'),
      completed: count('completed', 'goal_reached', 'exited'),
      failed: count('failed'),
      onStep,
      passed,
      failedAt,
    };
  }

  /** Run counts for every workflow (automations overview page). */
  async overview(ctx: HookContext) {
    await this.tick(ctx);
    const workflows = await ctx.store.all('workflows');
    const allRuns = await ctx.store.all<RunRow>(RUNS, { test: false });
    const today = Math.floor(Date.now() / DAY);
    const out: Record<string, unknown> = {};
    for (const w of workflows) {
      const runs = allRuns.filter((r) => r.workflowId === w.id);
      const daily = Array.from({ length: 14 }, () => 0);
      let lastRunAt: string | null = null;
      for (const r of runs) {
        const ago = today - Math.floor(Date.parse(r.startedAt) / DAY);
        if (ago >= 0 && ago < 14) daily[13 - ago]++;
        if (!lastRunAt || r.startedAt > lastRunAt) lastRunAt = r.startedAt;
      }
      const s = await this.stats(ctx, w.id, runs);
      const finished = s.completed + s.failed;
      out[w.id] = {
        ...s,
        lastRunAt,
        daily,
        successRate: finished ? s.completed / finished : null,
      };
    }
    return out;
  }

  /** Runs the current draft for one contact: full log, nothing sent, waits skipped. */
  async testRun(
    ctx: HookContext,
    workflowId: string,
    contactId: unknown,
    draft: unknown,
  ) {
    const contact = await ctx.store.find<Row & Contact>(
      'contacts',
      text(contactId),
    );
    const w = await ctx.store.find<WorkflowRow>('workflows', workflowId);
    const source = upgrade({
      ...w,
      ...((draft as object) ?? {}),
    } as WorkflowRow);
    const run = await this.engine(ctx);
    const state = run(
      definitionOf(source),
      { variables: {}, pathChoices: {}, log: [] },
      contact,
      { test: true, now: Date.now() },
    );
    return ctx.store.insert(RUNS, {
      workflowId,
      version: w.version ?? 0,
      contactId: contact.id,
      contactName: `${contact.firstName} ${contact.lastName}`.trim(),
      startedAt: new Date().toISOString(),
      test: true,
      ...state,
    });
  }

  /** Starts a live run on the workflow's current version (incoming webhook, triggers). */
  async enrol(
    ctx: HookContext,
    w: WorkflowRow,
    contact: (Row & Contact) | null,
    trigger: Record<string, string>,
    options: { ignoreReentry?: boolean } = {},
  ) {
    const def = this.liveDefinition(w, w.version);
    if (!def || w.status !== 'active') return null;
    if (
      contact &&
      !options.ignoreReentry &&
      !def.allowReentry &&
      (await ctx.store.count(RUNS, {
        workflowId: w.id,
        contactId: contact.id,
        test: false,
      }))
    ) {
      return null; // already enrolled and re-entry is off
    }
    const run = await this.engine(ctx);
    const state = run(
      def,
      { variables: {}, pathChoices: {}, log: [] },
      contact,
      { test: false, now: Date.now(), trigger, liveEvents: true },
    );
    const saved = await ctx.store.insert<RunRow>(RUNS, {
      workflowId: w.id,
      version: w.version,
      contactId: contact?.id ?? null,
      contactName: contact
        ? `${contact.firstName} ${contact.lastName}`.trim()
        : 'Unknown contact',
      startedAt: new Date().toISOString(),
      test: false,
      triggerData: trigger,
      ...state,
    });
    await this.afterSteps(ctx, def, saved, 0, contact);
    return saved;
  }

  /** Re-runs a failed run from the step that failed. */
  async retryRun(ctx: HookContext, runId: string) {
    const r = await ctx.store.find<RunRow>(RUNS, runId);
    if (r.status !== 'failed' || !r.currentStepId)
      throw invalidState('Only failed runs can be retried.');
    const w = await ctx.store.find<WorkflowRow>('workflows', r.workflowId);
    const def = this.liveDefinition(w, r.version);
    if (!def) {
      throw new HttpException(
        {
          message: 'The version this run used no longer exists.',
          error: 'Conflict',
          code: 'VERSION_MISSING',
        },
        HttpStatus.CONFLICT,
      );
    }
    const attempt =
      r.log.filter((l) => l.message.startsWith('Retrying')).length + 2;
    const contact = await this.contactOf(ctx, r.contactId);
    const run = await this.engine(ctx);
    const before = r.log.length;
    const state = run(
      def,
      r,
      contact,
      {
        test: r.test,
        now: Date.now(),
        resume: { stepId: r.currentStepId, inclusive: true },
        trigger: r.triggerData,
        liveEvents: !r.test,
      },
      attempt,
    );
    const saved = await ctx.store.patch<RunRow>(
      RUNS,
      runId,
      state as unknown as Record<string, unknown>,
    );
    await this.afterSteps(ctx, def, saved, before, contact);
    return saved;
  }

  async cancelRun(ctx: HookContext, runId: string) {
    const r = await ctx.store.find<RunRow>(RUNS, runId);
    if (!['running', 'waiting'].includes(r.status))
      throw invalidState('This run has already finished.');
    const at = new Date().toISOString();
    return ctx.store.patch(RUNS, runId, {
      status: 'cancelled',
      finishedAt: at,
      resumeAt: null,
      log: [
        ...r.log,
        {
          id: randomUUID(),
          stepId: 'system',
          stepType: 'system',
          label: 'Cancelled',
          status: 'info',
          at,
          durationMs: 0,
          message: `Cancelled by ${ctx.actorName}`,
        },
      ],
    });
  }

  // ---------- Incoming webhook ----------

  /** Finds the contact a webhook body identifies. */
  async findContact(ctx: HookContext, by: string, identifier: string) {
    if (by === 'id')
      return ctx.store.findOrNull<Row & Contact>('contacts', identifier);
    const field = by === 'phone' ? 'phone' : 'email';
    const [row] = await ctx.store.em.query<{ id: string }[]>(
      `SELECT id FROM product_records WHERE tenant_id = $1 AND collection = 'contacts'
       AND ${field === 'email' ? `lower(data->>'email') = lower($2)` : `data->>'phone' = $2`} LIMIT 1`,
      [ctx.store.tenantId, identifier],
    );
    return row ? ctx.store.find<Row & Contact>('contacts', row.id) : null;
  }

  /** Checks the builder's sample body against the draft trigger config; enrols nobody. */
  async testWebhook(
    ctx: HookContext,
    workflowId: string,
    configInput: unknown,
  ) {
    const config = (configInput ?? {}) as Record<string, string>;
    const w = await ctx.store.find<WorkflowRow>('workflows', workflowId);
    const body = parseSample(config.samplePayload);
    if (body.error || !body.value) {
      throw new HttpException(
        {
          message: body.error ?? 'Send a JSON object in the request body.',
          error: 'Bad Request',
          code: 'INVALID_BODY',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const fields = Object.fromEntries(flattenPayload(body.value));
    const identifier = (fields[config.contactPath ?? ''] ?? '').trim();
    if (!identifier) {
      throw fieldError(
        422,
        'CONTACT_FIELD_MISSING',
        'contactPath',
        `The body has no “${config.contactPath}” field to identify the contact.`,
      );
    }
    const contact = await this.findContact(
      ctx,
      config.matchBy ?? 'email',
      identifier,
    );
    return {
      status: 202,
      requestId: `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      receivedAt: new Date().toISOString(),
      identifier,
      contact: contact
        ? {
            id: contact.id,
            name: `${contact.firstName} ${contact.lastName}`.trim(),
          }
        : null,
      wouldCreate: !contact && config.createContact === 'true',
      live: w.status === 'active',
      fields: Object.keys(fields).length,
    };
  }

  async webhookRequests(ctx: HookContext, workflowId: string) {
    const page = await ctx.store.list(RUNS, RUN_SHAPE, {
      filters: { workflowId, test: 'false' },
      sort: 'startedAt',
      order: 'desc',
      perPage: 8,
    });
    return page.data.map((r) => ({
      id: text(r.requestId) || `req_${r.id.replace(/-/g, '').slice(0, 12)}`,
      receivedAt: r.startedAt,
      status: 202,
      contactName: r.contactName,
      runId: r.id,
    }));
  }
}
