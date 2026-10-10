/**
 * Meta Flow JSON structural checks.
 *
 * Shared on purpose: the Create Form panel runs this on blur to warn
 * before a round-trip, and POST /api/whatsapp-flows runs it again before
 * spending a Graph API call. One implementation means the two can't
 * disagree — a client that waves through JSON the server would reject is
 * worse than no pre-check at all.
 *
 * Scope: *structure*, not schema. We verify the JSON parses, is an
 * object, and carries the two top-level keys Meta's builder always emits
 * (`version` + a `screens` array). Anything deeper — component types,
 * data-requirements, publishing checks — is Meta's validator's job, and
 * its verdict arrives as `validation_errors` on the create response.
 */

export type FlowJsonIssue =
  | 'empty'
  | 'invalidJson'
  | 'notObject'
  | 'missingVersion'
  | 'missingScreens'
  | 'screensNotArray';

export interface FlowJsonInspection {
  ok: boolean;
  /** Present only when `ok` is false. A code, not prose — the UI owns the wording. */
  issue?: FlowJsonIssue;
  /** Number of screens when the JSON is structurally sound; drives `whatsapp_flows.screens_count`. */
  screensCount: number;
  /** Flow JSON version string when present (e.g. "5.0"). */
  version?: string;
  /**
   * `id` of the first screen, when the JSON carries one. A template's
   * FLOW button needs it as `navigate_screen`, so we read it now (and
   * store the whole document) rather than re-parsing tens of KB later.
   */
  firstScreenId: string | null;
}

export function inspectFlowJson(text: string): FlowJsonInspection {
  if (!text || text.trim().length === 0) {
    return { ok: false, issue: 'empty', screensCount: 0, firstScreenId: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, issue: 'invalidJson', screensCount: 0, firstScreenId: null };
  }

  // Arrays and null both `typeof === 'object'`, and neither is a Flow.
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { ok: false, issue: 'notObject', screensCount: 0, firstScreenId: null };
  }

  const flow = parsed as Record<string, unknown>;

  // Meta's builder emits `version` as a string; a number is a copy-paste
  // from a hand-written doc, so accept either but keep the original text
  // for Meta untouched.
  if (flow.version === undefined || flow.version === null || flow.version === '') {
    return { ok: false, issue: 'missingVersion', screensCount: 0, firstScreenId: null };
  }

  if (flow.screens === undefined || flow.screens === null) {
    return { ok: false, issue: 'missingScreens', screensCount: 0, firstScreenId: null };
  }
  if (!Array.isArray(flow.screens)) {
    return { ok: false, issue: 'screensNotArray', screensCount: 0, firstScreenId: null };
  }

  return {
    ok: true,
    screensCount: flow.screens.length,
    version: String(flow.version),
    firstScreenId: firstScreenIdOf(flow.screens),
  };
}

/**
 * First screen `id` of a parsed `screens` array, or null.
 *
 * Not a structural *requirement*: Meta's own validator is the authority
 * on screen shape, and rejecting here would block JSON our user copied
 * out of the builder for an unrelated reason. Callers that need the
 * entry screen (the FLOW button payload) treat null as "the Flow is
 * unusable in a template" and say so.
 */
export function firstScreenIdOf(screens: unknown): string | null {
  if (!Array.isArray(screens)) return null;
  const first = screens[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const id = (first as Record<string, unknown>).id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Flatten Meta's `validation_errors` into one human-readable line.
 *
 * Meta sends an array of { error, error_type, message, pointers[] }. The
 * panel shows a single inline message, so we join with " · " and cap the
 * length — a 40-error JSON dump is unreadable, and the first few are
 * almost always the root cause (later ones cascade from it).
 */
export function describeFlowValidationErrors(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const lines = errors
    .map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') {
        const rec = e as Record<string, unknown>;
        const message = typeof rec.message === 'string' ? rec.message : '';
        const path = firstPointerPath(rec.pointers);
        return path ? `${message} (at ${path})` : message;
      }
      return '';
    })
    .filter((line) => line.length > 0);

  if (lines.length === 0) return null;
  const shown = lines.slice(0, 5);
  const suffix = lines.length > shown.length ? ` · +${lines.length - shown.length} more` : '';
  return (shown.join(' · ') + suffix).slice(0, 900);
}

function firstPointerPath(pointers: unknown): string | null {
  if (!Array.isArray(pointers)) return null;
  const first = pointers[0];
  if (first && typeof first === 'object' && 'path' in first) {
    const path = (first as { path?: unknown }).path;
    if (typeof path === 'string' && path) return path;
  }
  return null;
}
