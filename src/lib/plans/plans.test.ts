import { describe, expect, it } from 'vitest';

import {
  addCalendarMonths,
  advancePeriod,
  currentWindowAnchor,
  windowMonthKey,
} from './period';
import { computeEffectiveStatus } from './entitlements';
import {
  FEATURE_FLAGS,
  GRACE_DAYS,
  LIMIT_FEATURES,
  LIMIT_SOURCE_TABLES,
  TRIAL_DAYS,
  UNLIMITED,
} from './config';

// ============================================================
// PART 1 / PART 7 — the parts of the plan engine that are pure and
// therefore testable without a database: calendar period math (with
// the end-of-month clamping Part 2 calls out), the request-time
// effective-status computation (Part 3), and the shape of the
// config the whole system reads.
//
// The DB-backed rules — limit enforcement, usage increments, renewal
// idempotency, downgrade grandfathering — need a live Postgres +
// the 048 seed and are exercised end-to-end by the API. What follows
// covers the deterministic core the spec's test table names:
//   · yearly = monthly reset windows anchored to the period start
//   · expiry / grace / trial / cancel
//   · clock injection keeps them timezone-independent
// ============================================================

const iso = (d: Date) => d.toISOString();
const at = (y: number, m: number, day: number, h = 0) =>
  new Date(Date.UTC(y, m - 1, day, h)); // m is 1-based

describe('addCalendarMonths — clamped end-of-month (Part 2)', () => {
  it('31 Jan + 1 month = end of Feb (non-leap)', () => {
    expect(iso(addCalendarMonths(at(2026, 1, 31), 1))).toBe(iso(at(2026, 2, 28)));
  });

  it('31 Jan + 1 month = Feb 29 on a leap year', () => {
    expect(iso(addCalendarMonths(at(2024, 1, 31), 1))).toBe(iso(at(2024, 2, 29)));
  });

  it('30 Jan + 1 month clamps to Feb 28 (kept day 30 overflow)', () => {
    expect(iso(addCalendarMonths(at(2026, 1, 30), 1))).toBe(iso(at(2026, 2, 28)));
  });

  it('31 Mar + 1 month = 30 Apr', () => {
    expect(iso(addCalendarMonths(at(2026, 3, 31), 1))).toBe(iso(at(2026, 4, 30)));
  });

  it('preserves time-of-day on the clamp day', () => {
    expect(iso(addCalendarMonths(at(2026, 1, 31, 10), 1))).toBe(iso(at(2026, 2, 28, 10)));
  });

  it('a normal day just advances the month', () => {
    expect(iso(addCalendarMonths(at(2026, 1, 15), 1))).toBe(iso(at(2026, 2, 15)));
  });

  it('wraps the year, and +12 lands on the same calendar day next year', () => {
    expect(iso(addCalendarMonths(at(2026, 1, 15), 12))).toBe(iso(at(2027, 1, 15)));
    expect(iso(addCalendarMonths(at(2026, 12, 15), 1))).toBe(iso(at(2027, 1, 15)));
  });

  it('steps backwards (used when a stray now precedes the anchor)', () => {
    expect(iso(addCalendarMonths(at(2026, 3, 31), -1))).toBe(iso(at(2026, 2, 28)));
  });
});

describe('advancePeriod — one billing cycle', () => {
  it('monthly advances one month', () => {
    expect(iso(advancePeriod(at(2026, 1, 15), 'monthly'))).toBe(iso(at(2026, 2, 15)));
  });
  it('yearly advances twelve months', () => {
    expect(iso(advancePeriod(at(2026, 1, 15), 'yearly'))).toBe(iso(at(2027, 1, 15)));
  });
});

describe('computeEffectiveStatus — request-time status (Part 3)', () => {
  const base = {
    status: 'active' as const,
    current_period_end: iso(at(2026, 2, 15)),
    trial_end: null,
  };

  it('is active before the period end', () => {
    expect(computeEffectiveStatus(base, at(2026, 2, 1))).toBe('active');
  });

  it('flips to expired the instant the period end passes', () => {
    expect(computeEffectiveStatus(base, at(2026, 2, 16))).toBe('expired');
    expect(computeEffectiveStatus(base, at(2026, 3, 1))).toBe('expired');
  });

  it('honours a grace window when one is configured', () => {
    // +2 days grace: just past the end is still active, well past is expired.
    expect(computeEffectiveStatus(base, at(2026, 2, 16), 2)).toBe('active');
    expect(computeEffectiveStatus(base, at(2026, 2, 20), 2)).toBe('expired');
  });

  it('defaults to zero grace (a lapsed sub is expired immediately)', () => {
    expect(GRACE_DAYS).toBe(0);
    expect(computeEffectiveStatus(base, at(2026, 2, 15, 1))).toBe('expired');
  });

  it('maps trialing and reads trial_end when there is no period end', () => {
    const trial = {
      status: 'trialing' as const,
      current_period_end: null,
      trial_end: iso(at(2026, 2, 10)),
    };
    expect(computeEffectiveStatus(trial, at(2026, 2, 1))).toBe('trialing');
    expect(computeEffectiveStatus(trial, at(2026, 2, 11))).toBe('expired');
  });

  it('a canceled sub is expired regardless of dates', () => {
    const canceled = {
      status: 'canceled' as const,
      current_period_end: iso(at(2099, 1, 1)),
      trial_end: null,
    };
    expect(computeEffectiveStatus(canceled, at(2026, 1, 1))).toBe('expired');
  });

  it('no subscription at all is expired (fail closed)', () => {
    expect(computeEffectiveStatus(null, at(2026, 1, 1))).toBe('expired');
  });

  it('past_due keeps its granted window until the period end passes', () => {
    const pastDue = { ...base, status: 'past_due' as const };
    expect(computeEffectiveStatus(pastDue, at(2026, 2, 1))).toBe('active');
    expect(computeEffectiveStatus(pastDue, at(2026, 2, 16))).toBe('expired');
  });
});

describe('monthly reset windows on a yearly plan (Part 1)', () => {
  // A yearly subscription that started on the 15th resets its bulk
  // quota on the 15th each month — anchored to the period start, never
  // the calendar 1st, and each window is discrete (no rollover).
  const subStart = at(2026, 1, 15);

  it('stays in the same window before the monthly boundary', () => {
    expect(windowMonthKey(subStart, at(2026, 1, 20))).toBe('2026-01-15');
    expect(windowMonthKey(subStart, at(2026, 2, 14))).toBe('2026-01-15');
  });

  it('advances to a fresh window the moment the monthly boundary passes', () => {
    expect(windowMonthKey(subStart, at(2026, 2, 15))).toBe('2026-02-15');
    // Mar 10 is still inside the Feb-15 → Mar-15 window (the anchor is
    // the most recent boundary at-or-before `now`).
    expect(windowMonthKey(subStart, at(2026, 3, 10))).toBe('2026-02-15');
    // Only after Mar 15 does it roll into the next discrete window.
    expect(windowMonthKey(subStart, at(2026, 3, 20))).toBe('2026-03-15');
  });

  it('clamps a 31-Jan start through the short Feb window', () => {
    const jan31 = at(2026, 1, 31);
    expect(windowMonthKey(jan31, at(2026, 2, 5))).toBe('2026-01-31');
    // Feb has no 31st; the anchor walks to the clamped 28th.
    expect(windowMonthKey(jan31, at(2026, 3, 5))).toBe('2026-02-28');
  });

  it('stays on the period start within the first window', () => {
    // A `now` inside the very first window keeps the anchor at the
    // subscription start (no earlier boundary is chosen).
    expect(currentWindowAnchor(subStart, at(2026, 1, 20)).getTime()).toBe(
      subStart.getTime()
    );
    expect(currentWindowAnchor(subStart, subStart).getTime()).toBe(subStart.getTime());
  });
});

describe('config shape (regression guard)', () => {
  it('trial length and unlimited sentinel match the spec', () => {
    expect(TRIAL_DAYS).toBe(7);
    expect(UNLIMITED).toBe(-1);
  });

  it('every counted limit maps to a source table (or null for counter-backed)', () => {
    for (const feature of LIMIT_FEATURES) {
      expect(LIMIT_SOURCE_TABLES).toHaveProperty(feature);
    }
  });

  it('team_members and bulk_messages are the counter-backed (null-table) features', () => {
    expect(LIMIT_SOURCE_TABLES.team_members).toBeNull();
    expect(LIMIT_SOURCE_TABLES.bulk_messages).toBeNull();
  });

  it('feature flags match what the entitlements route + gated CTAs read', () => {
    expect(FEATURE_FLAGS).toEqual(
      expect.arrayContaining(['fields_tags', 'broadcast_scheduler'])
    );
    expect(LIMIT_FEATURES).toEqual(
      expect.arrayContaining([
        'contacts',
        'bulk_messages',
        'templates',
        'quick_replies',
        'automation_flows',
        'whatsapp_forms',
        'team_members',
      ])
    );
  });
});
