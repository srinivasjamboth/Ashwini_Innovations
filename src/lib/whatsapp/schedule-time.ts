// ============================================================
// Schedule Broadcast — wall-clock ⇄ UTC instant helpers.
//
// A user schedules in their (or a chosen) timezone as a plain date +
// time on the wall clock. What we persist is an absolute instant
// (`broadcasts.scheduled_at TIMESTAMPTZ`), which is what the cron
// compares against `now()`. Converting wall-clock-in-zone → UTC is
// fiddly because of DST, so it lives here in one tested, dependency-
// free spot the client wizard and the server route can both use.
//
// Client-safe: relies only on the Intl API. No Supabase / next-headers
// imports, so it can be imported from a browser component.
// ============================================================

/** A curated fallback when `Intl.supportedValuesOf` is unavailable. */
const FALLBACK_ZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Africa/Cairo',
  'Africa/Lagos',
];

export class ScheduleTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleTimeError';
  }
}

/**
 * IANA zone names for the timezone <select>. The viewer's own zone is
 * listed first (under its own name) so it is the sensible default; UTC is
 * always offered. Order is otherwise ascending.
 */
export function getTimeZoneOptions(): string[] {
  let zones: string[];
  try {
    // `supportedValuesOf` is ES2022; not present on every runtime.
    const intl = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    zones =
      typeof intl.supportedValuesOf === 'function'
        ? intl.supportedValuesOf('timeZone')
        : FALLBACK_ZONES;
  } catch {
    zones = FALLBACK_ZONES;
  }

  const local = getLocalTimeZone();
  const set = new Set(zones.length ? zones : FALLBACK_ZONES);
  set.add(local);
  set.add('UTC');
  const sorted = [...set].sort();
  // Pull the viewer's zone to the front for a friendly default.
  return [local, ...sorted.filter((z) => z !== local)];
}

/** The runtime's IANA zone, or 'UTC' if it can't be determined. */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Whole-minute offset (ms) of `timeZone` from UTC at the instant `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second,
  );
  // Round to whole minutes; sub-minute offsets are not a thing in practice.
  return asUtc - at.getTime();
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/**
 * Convert a wall-clock date + time in `timeZone` to a UTC Date.
 *
 * `date` is 'YYYY-MM-DD', `time` is 'HH:MM' (24h). Throws
 * {@link ScheduleTimeError} on a malformed input or an unknown zone.
 *
 * The two-pass offset correction handles the case where the first guess
 * lands on the wrong side of a DST transition.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm) throw new ScheduleTimeError('Invalid date — expected YYYY-MM-DD.');
  if (!tm) throw new ScheduleTimeError('Invalid time — expected HH:MM (24h).');

  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, min] = [Number(tm[1]), Number(tm[2])];

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) {
    throw new ScheduleTimeError('Date or time out of range.');
  }
  // Reject non-existent calendar days (e.g. Feb 30) via round-trip.
  const sanity = new Date(Date.UTC(y, mo - 1, d));
  if (
    sanity.getUTCFullYear() !== y ||
    sanity.getUTCMonth() !== mo - 1 ||
    sanity.getUTCDate() !== d
  ) {
    throw new ScheduleTimeError('That calendar date does not exist.');
  }

  try {
    // Validate the zone eagerly — Intl throws RangeError on garbage.
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ScheduleTimeError(`Unknown timezone: ${timeZone}`);
  }

  const wallAsUtc = Date.UTC(y, mo - 1, d, h, min, 0);
  let instant = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  const corrected = wallAsUtc - zoneOffsetMs(new Date(instant), timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** Wall-clock 'YYYY-MM-DD' + 'HH:MM' in `timeZone`, for re-display. */
export function utcToZonedParts(instant: Date | string, timeZone: string): {
  date: string;
  time: string;
} {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  const zone = isKnownZone(timeZone) ? timeZone : 'UTC';
  const parts: Record<string, number> = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return {
    date: `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour % 24)}:${pad(parts.minute)}`,
  };
}

/** Human date + time rendered in `timeZone` (falls back to local). */
export function formatScheduledInZone(instant: Date | string, timeZone?: string): string {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  const zone = timeZone && isKnownZone(timeZone) ? timeZone : getLocalTimeZone();
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}

/** True when `iso` is strictly after `now` (with an optional skew). */
export function isFuture(instant: Date | string, now: Date = new Date()): boolean {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  return at.getTime() > now.getTime();
}

/**
 * The minimum lead a scheduled broadcast must have over "now". One
 * source of truth shared by the wizard (so its inline hint + enabled
 * button never disagree with) and the schedule endpoint (which rejects
 * anything inside this window as effectively "Send Now"). Kept small so
 * a genuine "in a minute" / "in an hour" pick always passes.
 */
export const SCHEDULE_MIN_LEAD_MS = 30_000;

/**
 * The acceptance rule the server enforces: the instant must sit at
 * least `leadMs` in the future. A past time and an almost-now time both
 * fail here — exactly what the endpoint rejects — so enabling the button
 * on a green light guarantees the server won't bounce it.
 */
export function hasScheduleLead(
  instant: Date | string,
  now: Date = new Date(),
  leadMs: number = SCHEDULE_MIN_LEAD_MS,
): boolean {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  return at.getTime() - now.getTime() >= leadMs;
}

function isKnownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
