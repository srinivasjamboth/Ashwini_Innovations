/**
 * Admin login throttle — temporary lockout with increasing backoff,
 * tracked per email AND per IP.
 *
 * Policy: the first LOGIN_LOCK_THRESHOLD failures on a key are
 * answered normally (so a couple of typos never trap anyone); from
 * strike threshold+1 onwards every attempt is refused until the
 * lockout elapses, and each further failure doubles the window:
 * 1 min, 2, 4, … capped at LOGIN_LOCK_MAX_MS. Counters decay after
 * LOGIN_STRIKE_DECAY_MS of quiet.
 *
 * Deliberately in-process (same trade-off as src/lib/rate-limit.ts:
 * one Node instance for this deployment shape; swap for Redis when
 * scaling horizontally). The coarse per-IP request budget still runs
 * through the shared fixed-window limiter in the login route itself.
 */

import {
  LOGIN_LOCK_BASE_MS,
  LOGIN_LOCK_MAX_MS,
  LOGIN_LOCK_THRESHOLD,
  LOGIN_STRIKE_DECAY_MS,
} from './constants'

interface StrikeEntry {
  failures: number
  lockedUntil: number
  lastFailureAt: number
}

const strikes = new Map<string, StrikeEntry>()

/** IP lockouts need more headroom than email ones: many employees can
 *  share one office NAT address, so the trigger sits higher before a
 *  whole-floor typo storm locks everyone out. */
const IP_LOCK_THRESHOLD = LOGIN_LOCK_THRESHOLD * 2

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export type ThrottleKey =
  | { kind: 'email'; value: string }
  | { kind: 'ip'; value: string }

function keyOf(k: ThrottleKey): string {
  return k.kind === 'email'
    ? `e:${normalizeEmail(k.value)}`
    : `i:${k.value}`
}

function thresholdFor(k: ThrottleKey): number {
  return k.kind === 'email' ? LOGIN_LOCK_THRESHOLD : IP_LOCK_THRESHOLD
}

/**
 * Is this key currently locked out? Applies the decay window first
 * (quiet too long ⇒ the slate is wiped), then compares the clock.
 */
export function isLockedOut(key: ThrottleKey, now = Date.now()): { locked: boolean; retryInMs: number } {
  const id = keyOf(key)
  const entry = strikes.get(id)
  if (!entry) return { locked: false, retryInMs: 0 }

  if (now - entry.lastFailureAt > LOGIN_STRIKE_DECAY_MS) {
    strikes.delete(id)
    return { locked: false, retryInMs: 0 }
  }
  if (entry.lockedUntil > now) {
    return { locked: true, retryInMs: entry.lockedUntil - now }
  }
  return { locked: false, retryInMs: 0 }
}

/** Record a failed attempt for a key and compute any new lockout. */
export function registerFailure(key: ThrottleKey, now = Date.now()): void {
  const id = keyOf(key)
  const existing = strikes.get(id)

  // Decay: a fresh strike after long quiet starts from zero again.
  const decayed = !existing || now - existing.lastFailureAt > LOGIN_STRIKE_DECAY_MS
  const failures = (decayed ? 0 : existing!.failures) + 1

  let lockedUntil = existing && !decayed ? existing.lockedUntil : 0
  if (failures >= thresholdFor(key)) {
    // Strike N past the threshold doubles the window: threshold → 1×,
    // threshold+1 → 2×, threshold+2 → 4×, … capped.
    const exponent = Math.min(failures - thresholdFor(key), 10)
    const window = Math.min(LOGIN_LOCK_BASE_MS * 2 ** exponent, LOGIN_LOCK_MAX_MS)
    lockedUntil = now + window
  }

  strikes.set(id, { failures, lockedUntil, lastFailureAt: now })
}

/** Credentials verified — forget everything about this key. */
export function registerSuccess(key: ThrottleKey): void {
  strikes.delete(keyOf(key))
}

/** Test-only helper. */
export function __resetAdminThrottleForTests(): void {
  strikes.clear()
}
