/**
 * Automation trigger dispatch: turns data changes and tracked events into
 * enrolments, and resumes runs that are waiting for an event.
 *
 * Pure functions only (no database); AutomationService wires them to the store.
 */
import type { Row, StoreChange } from '../records/record-store';
import { str } from '../delivery/providers';
import type { TriggerType, WorkflowDefinition } from './engine/types';

/** Something that happened to one contact that automations may react to. */
export interface TriggerEvent {
  type: TriggerType;
  contactId: string;
  /** Compared with the trigger's field: list id, tag, form name, channel, stage name, event name. */
  key?: string;
  /** `{{trigger.*}}` values for the run. */
  values: Record<string, string>;
}

/** The trigger config field each type is matched on (`undefined`: matches every event of the type). */
const MATCH_FIELD: Partial<Record<TriggerType, string>> = {
  added_to_list: 'listId',
  tag_added: 'tag',
  form_submitted: 'form',
  message_received: 'channel',
  deal_stage_changed: 'stage',
  webhook: 'event',
};

/** Types where text comparisons ignore case (names typed by people). */
const CASE_INSENSITIVE = new Set<TriggerType>([
  'tag_added',
  'form_submitted',
  'deal_stage_changed',
]);

/** Event types the dispatcher fires (incoming_webhook and date_attribute have their own entry points). */
export const DISPATCHED_TYPES = new Set<TriggerType>([
  'contact_created',
  'added_to_list',
  'tag_added',
  'form_submitted',
  'message_received',
  'email_opened',
  'link_clicked',
  'deal_stage_changed',
  'webhook',
]);

/** Does a published trigger react to this event? An empty config value means "any". */
export function matchesTrigger(
  trigger: WorkflowDefinition['trigger'],
  event: TriggerEvent,
): boolean {
  if (trigger.type !== event.type) return false;
  const field = MATCH_FIELD[event.type];
  if (!field) return true;
  const wanted = (trigger.config?.[field] ?? '').trim();
  // A custom event trigger must name its event; the others accept any value when blank.
  if (!wanted) return event.type !== 'webhook';
  const got = (event.key ?? '').trim();
  return CASE_INSENSITIVE.has(event.type)
    ? wanted.toLowerCase() === got.toLowerCase()
    : wanted === got;
}

/** Custom event names that count as "Places an order" for Wait for event. */
const ORDER_EVENTS = new Set([
  'order_placed',
  'order.placed',
  'order.created',
  'order_created',
  'purchase',
  'checkout.completed',
]);

/** The Wait-for-event option an event satisfies (see WAIT_EVENTS), if any. */
export function waitEventOf(event: TriggerEvent): string | null {
  switch (event.type) {
    case 'email_opened':
      return 'email_opened';
    case 'link_clicked':
      return 'email_clicked';
    case 'message_received':
      return 'message_replied';
    case 'form_submitted':
      return 'form_submitted';
    case 'tag_added':
      return 'tag_added';
    case 'webhook':
      return ORDER_EVENTS.has((event.key ?? '').toLowerCase())
        ? 'order_placed'
        : null;
    default:
      return null;
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export interface ChangeLookups {
  listName: (id: string) => string;
  stageName: (pipelineId: string, stageId: string) => string;
}

/**
 * Contact and deal writes → trigger events.
 * - new contact: contact_created, plus tag_added / added_to_list for what it starts with;
 * - updated contact: tag_added / added_to_list for tags and lists it gained;
 * - updated deal with a contact: deal_stage_changed when stageId changed.
 */
export function eventsFromChanges(
  changes: StoreChange[],
  lookups: ChangeLookups,
): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  for (const { collection, before, after } of changes) {
    if (collection === 'contacts') {
      const contactId = after.id;
      if (!before) {
        events.push({
          type: 'contact_created',
          contactId,
          values: { source: str(after.source) },
        });
      }
      const hadTags = new Set(
        strings(before?.tags).map((t) => t.toLowerCase()),
      );
      for (const tag of strings(after.tags)) {
        if (!hadTags.has(tag.toLowerCase()))
          events.push({
            type: 'tag_added',
            contactId,
            key: tag,
            values: { tag },
          });
      }
      const hadLists = new Set(strings(before?.listIds));
      for (const listId of strings(after.listIds)) {
        if (!hadLists.has(listId))
          events.push({
            type: 'added_to_list',
            contactId,
            key: listId,
            values: { list_id: listId, list_name: lookups.listName(listId) },
          });
      }
    } else if (collection === 'deals' && before) {
      const contactId =
        typeof after.contactId === 'string' ? after.contactId : '';
      const stageId = str(after.stageId);
      if (!contactId || !stageId || stageId === str(before.stageId)) continue;
      const stage = lookups.stageName(str(after.pipelineId), stageId);
      events.push({
        type: 'deal_stage_changed',
        contactId,
        key: stage,
        values: {
          stage,
          previous_stage: lookups.stageName(
            str(before.pipelineId),
            str(before.stageId),
          ),
          deal_id: after.id,
          deal_name: str(after.title, str(after.name)),
          value: str(after.value),
        },
      });
    }
  }
  return events;
}

/** Month and day of a date value (`1990-07-14`, `07-14`, an ISO timestamp), or null. */
export function monthDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** A contact's date attribute: top-level field or custom attribute. */
export function dateAttribute(contact: Row, attribute: string): string | null {
  const key = attribute.replace(/^attributes\./, '');
  const attrs = (contact.attributes ?? {}) as Record<string, unknown>;
  return monthDay(attrs[key] ?? contact[key]);
}
