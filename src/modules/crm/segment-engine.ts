/**
 * Segment rules evaluated against a contact. Same semantics as the frontend's
 * mock engine (frontend-react/src/api/mock/segment-engine.ts) so previews and
 * saved segment counts match what the UI showed while it ran on mocks.
 */
export interface SegmentRule {
  id?: string;
  field: string;
  operator: string;
  value: string;
}

export interface SegmentRuleGroup {
  match: 'all' | 'any';
  rules: SegmentRule[];
}

/** Reads `country`, `consents.email`, `attributes.plan`… from a contact. */
function read(contact: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown> | null)?.[key],
      contact,
    );
}

function test(contact: Record<string, unknown>, rule: SegmentRule): boolean {
  const value = read(contact, rule.field);
  const text = Array.isArray(value)
    ? value.join(',')
    : value === null || value === undefined || typeof value === 'object'
      ? ''
      : String(value as string | number | boolean);
  const expected = String(rule.value ?? '').trim();
  const lower = text.toLowerCase();
  const list = () => expected.split(',').map((s) => s.trim().toLowerCase());
  switch (rule.operator) {
    case 'equals':
      return lower === expected.toLowerCase();
    case 'not_equals':
      return lower !== expected.toLowerCase();
    case 'contains':
      return lower.includes(expected.toLowerCase());
    case 'not_contains':
      return !lower.includes(expected.toLowerCase());
    case 'is_set':
      return value !== null && value !== undefined && text !== '';
    case 'is_not_set':
      return value === null || value === undefined || text === '';
    case 'greater_than':
      return Number(value) > Number(expected);
    case 'less_than':
      return Number(value) < Number(expected);
    case 'in_list':
      return list().includes(lower);
    case 'not_in_list':
      return !list().includes(lower);
    case 'has_tag':
      return Array.isArray(value) && value.includes(expected);
    case 'within_days':
      return (
        typeof value === 'string' &&
        Date.now() - Date.parse(value) <= Number(expected) * 86_400_000
      );
    default:
      return false;
  }
}

/** Empty groups match everyone, like an unfiltered audience. */
export function matchesSegment(
  contact: Record<string, unknown>,
  group: SegmentRuleGroup | null | undefined,
): boolean {
  const rules = (group?.rules ?? []).filter((r) => r?.field);
  if (rules.length === 0) return true;
  return group?.match === 'any'
    ? rules.some((r) => test(contact, r))
    : rules.every((r) => test(contact, r));
}

export function isRuleGroup(value: unknown): value is SegmentRuleGroup {
  const v = value as SegmentRuleGroup | null;
  return (
    !!v &&
    (v.match === 'all' || v.match === 'any') &&
    Array.isArray(v.rules) &&
    v.rules.every(
      (r) => r && typeof r.field === 'string' && typeof r.operator === 'string',
    )
  );
}
