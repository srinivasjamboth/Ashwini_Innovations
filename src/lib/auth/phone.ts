// ============================================================
// Phone numbers collected from members (signup + settings).
//
// Why we normalise instead of storing what was typed
// --------------------------------------------------
// The column (migration 044) carries a CHECK of
// `^\+?[0-9]{7,15}$`. Users type `(+91) 96401-11265`, `96401 11265`,
// `+91 9640111265` and mean the same number; storing the raw string
// would put three different values in one column and make every later
// comparison (dedup, support lookups) a formatting problem. So the
// browser strips separators before the write and the DB never sees a
// formatted value.
//
// Why no country-code inference
// -----------------------------
// Guessing a country from the leading digits needs a dialling-code
// table (and `+91…` vs `+1…` disagree on how many digits are local).
// Deliberately out of scope: we keep an optional `+` and the digits the
// user supplied, and validate shape only. Anything stricter would
// reject a valid local-format number the first time someone types
// `040 5550 1234` and the form decides they are in a country we
// guessed wrong about.
//
// Why 7 digits as the floor
// -------------------------
// A few countries genuinely run short (Tuvalu 5, some island numbers 6).
// 7 is comfortably above every real subscriber number while still
// stopping obvious mistypes like `1234`.
// ============================================================

/** Fewest digits accepted, counting the country code. */
export const PHONE_MIN_DIGITS = 7;
/** Most digits accepted — E.164's own ceiling. */
export const PHONE_MAX_DIGITS = 15;

/** The shape the DB CHECK enforces: optional `+`, then 7-15 digits. */
export const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;

/**
 * Strip everything that is not a digit, plus the single leading `+`
 * that marks a country code. Spaces, dashes, dots, parentheses and
 * brackets go. A `+` only counts as the country-code marker when it
 * appears before the first digit — which is what makes `(+91) 96401…`
 * and `+91 96401…` normalise to the same value while a stray second `+`
 * (`91+96401…`) is dropped, since it cannot mean anything.
 */
export function normalizePhone(raw: string): string {
  const squashed = raw.replace(/\s+/g, "");
  const plus = /^[^0-9]*\+/.test(squashed);
  const digits = squashed.replace(/[^0-9]/g, "");
  return plus ? `+${digits}` : digits;
}

/** Digits only — the count the length bounds are measured against. */
function digitCount(value: string): number {
  return value.replace(/[^0-9]/g, "").length;
}

/**
 * Does this look like a phone number? Empty is NOT valid here — the
 * caller decides whether the field is optional (Settings) or required
 * (signup), so it can pick between "leave it blank" and "that number
 * doesn't look right".
 */
export function isValidPhone(raw: string): boolean {
  const normalized = normalizePhone(raw);
  if (!normalized) return false;
  if (!PHONE_PATTERN.test(normalized)) return false;
  const digits = digitCount(normalized);
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

/**
 * The value to send to `profiles.phone`: normalised when it is a real
 * number, `null` when it is blank or unusable. Never returns a string
 * that would violate the column's CHECK, which keeps a stray write from
 * failing an otherwise valid request.
 */
export function phoneForDb(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const normalized = normalizePhone(raw);
  if (!normalized) return null;
  return isValidPhone(normalized) ? normalized : null;
}
