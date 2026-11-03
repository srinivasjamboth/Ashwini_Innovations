// ============================================================
// Contact filter model — the ONE filter definition shared by the
// group "Add by filter" panel and the Contacts page's "all matching"
// path (spec PART 4: "reuse the filter model, do not build a second
// implementation").
//
// A filter is a list of AND-ed rows: { field, op, value } plus an
// optional free-text search handled separately. Values are always
// plain strings; the server RPC dispatches on a fixed CASE whitelist,
// so nothing here is ever concatenated into SQL.
//
// Field keys:
//   'name' | 'phone' | 'email' | 'company'   — contact columns
//   'tag'                                     — value: tag id (or csv for in/nin)
//   'group'                                   — value: group id (or csv for in/nin)
//   'created_at'                              — Registered date; 'between' value
//                                               is "YYYY-MM-DD,YYYY-MM-DD"
//   'custom:<field-id>'                       — contact_custom_values.value (TEXT)
//
// Reality check vs the spec: this schema has no `source` column and no
// opted-out/soft-delete flag on contacts (verified across every
// migration), so those two fields are intentionally absent — a filter
// on a column nothing writes would silently match nobody.
// ============================================================

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts'
  | 'empty'
  | 'not_empty'
  | 'between'
  | 'in'
  | 'nin';

export interface ContactFilterCondition {
  /** 'name' | 'phone' | 'email' | 'company' | 'tag' | 'group' |
   *  'created_at' | 'custom:<uuid>' */
  field: string;
  op: FilterOp;
  /** Empty for the *empty ops. 'between' carries "from,to". 'in'/'nin'
   *  carry a comma-separated id list. */
  value: string;
}

/** Column-backed text fields — same search targets the contacts list
 *  already searches on. */
export const TEXT_FIELDS = ['name', 'phone', 'email', 'company'] as const;
export const TAG_FIELD = 'tag';
export const GROUP_FIELD = 'group';
export const DATE_FIELD = 'created_at';

const TEXT_FIELD_SET: ReadonlySet<string> = new Set(TEXT_FIELDS);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Cap AND-rows so one filter can't balloon into a query the planner
 *  can't run fast; 12 is far past any realistic builder use. */
export const MAX_CONDITIONS = 12;
/** Cap on id lists inside one 'in'/'nin' value. */
const MAX_ID_LIST = 500;
/** Cap on free-text values. */
const MAX_VALUE_LEN = 200;

export function opsForField(field: string): FilterOp[] {
  if (field === TAG_FIELD || field === GROUP_FIELD) {
    return ['eq', 'neq', 'in', 'nin'];
  }
  if (field === DATE_FIELD) {
    return ['eq', 'between'];
  }
  // Text columns and custom values (stored as TEXT) share the text ops.
  return ['eq', 'neq', 'contains', 'starts', 'empty', 'not_empty'];
}

export function isCustomFieldKey(field: string): boolean {
  return /^custom:[0-9a-f-]{36}$/i.test(field);
}

export function isKnownField(field: string): boolean {
  return (
    TEXT_FIELD_SET.has(field) ||
    field === TAG_FIELD ||
    field === GROUP_FIELD ||
    field === DATE_FIELD ||
    isCustomFieldKey(field)
  );
}

/** Value must be a bare uuid or a csv of uuids (id-list ops). */
function validIdValue(value: string): boolean {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    parts.length > 0 &&
    parts.length <= MAX_ID_LIST &&
    parts.every((p) => UUID_RE.test(p))
  );
}

function validDateValue(value: string): boolean {
  return DATE_RE.test(value.trim());
}

function validBetween(value: string): boolean {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length !== 2) return false;
  if (!validDateValue(parts[0]) || !validDateValue(parts[1])) return false;
  // An inverted range is legal (it simply matches nothing) but almost
  // certainly a mistake — reject so the UI keeps from/to straight.
  return parts[0] <= parts[1];
}

/** One condition, checked against the whitelist. Invalid rows are
 *  dropped rather than thrown — the preview should keep working while
 *  the user is mid-edit in the builder. */
export function sanitizeCondition(raw: unknown): ContactFilterCondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const { field, op, value } = raw as {
    field?: unknown;
    op?: unknown;
    value?: unknown;
  };
  if (typeof field !== 'string' || !isKnownField(field)) return null;
  if (typeof op !== 'string' || !(opsForField(field) as readonly string[]).includes(op)) {
    return null;
  }
  const v = typeof value === 'string' ? value.trim() : '';

  if (op === 'empty' || op === 'not_empty') return { field, op, value: '' };

  if (!v || v.length > MAX_VALUE_LEN) return null;

  if (field === TAG_FIELD || field === GROUP_FIELD) {
    if (op === 'in' || op === 'nin') {
      return validIdValue(v) ? { field, op: op as FilterOp, value: v } : null;
    }
    return UUID_RE.test(v) ? { field, op: op as FilterOp, value: v } : null;
  }

  if (field === DATE_FIELD) {
    if (op === 'between') {
      return validBetween(v) ? { field, op: op as FilterOp, value: v } : null;
    }
    return validDateValue(v) ? { field, op: op as FilterOp, value: v } : null;
  }

  // Text / custom: value is free text for eq/neq/contains/starts.
  return { field, op: op as FilterOp, value: v };
}

/** Whole-list sanitizer used before every RPC call. */
export function sanitizeConditions(raw: unknown): ContactFilterCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: ContactFilterCondition[] = [];
  for (const item of raw) {
    const c = sanitizeCondition(item);
    if (c) out.push(c);
    if (out.length >= MAX_CONDITIONS) break;
  }
  return out;
}

/** The Contacts page's existing tag/group/search filter shape mapped
 *  onto the same condition list, so its "select all N matching" path
 *  goes through the same server endpoint as the group builder.
 *  Each legacy dimension ORs internally — exactly what 'in' means. */
export function legacyFilterToConditions(filter: {
  tagIds?: string[];
  groupIds?: string[];
}): ContactFilterCondition[] {
  const out: ContactFilterCondition[] = [];
  const tagIds = (filter.tagIds ?? []).filter((id) => UUID_RE.test(id));
  const groupIds = (filter.groupIds ?? []).filter((id) => UUID_RE.test(id));
  if (tagIds.length > 0) out.push({ field: TAG_FIELD, op: 'in', value: tagIds.join(',') });
  if (groupIds.length > 0) out.push({ field: GROUP_FIELD, op: 'in', value: groupIds.join(',') });
  return out;
}

/** "2026-01-01,2026-03-15" pair used by the date-range op. */
export function betweenValue(from: string, to: string): string {
  return `${from.trim()},${to.trim()}`;
}

export function splitBetween(value: string): [string, string] {
  const [from = '', to = ''] = value.split(',');
  return [from.trim(), to.trim()];
}

export function hasActiveFilter(
  conditions: ContactFilterCondition[],
  search: string
): boolean {
  return conditions.length > 0 || search.trim().length > 0;
}
