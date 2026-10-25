/**
 * Plan engine — subscription period math.
 *
 * Part 2 requires calendar-month/year addition with end-of-month
 * clamping: "31 Jan + 1 month = end of Feb". Naive `date.setMonth(+1)`
 * overflows into March for those dates, so we compute the last valid day
 * of the target month explicitly. All math is done in UTC to match the
 * `timestamptz` values PostgREST hands back and to keep the clock-
 * injection tests deterministic across the machine's local timezone.
 */

import type { BillingCycle } from './types';

/**
 * Add a whole number of calendar months to `from`, clamping the day to
 * the last day of the target month. Time-of-day is preserved so a period
 * that starts at 10:15 ends at 10:15 on the clamp day.
 */
export function addCalendarMonths(from: Date, months: number): Date {
  const base = new Date(from.getTime());
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();

  const totalMonths = month + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;

  // Last day of the target month (month index is 0-based; day 0 of the
  // NEXT month is the last day of this one).
  const lastDayOfTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTarget);

  const result = new Date(from.getTime());
  result.setUTCFullYear(targetYear, targetMonth, clampedDay);
  return result;
}

/**
 * Advance a period end by one billing cycle. Monthly = +1 month,
 * yearly = +12 months. Renewal passes the PREVIOUS period end as `from`
 * so no days are lost (Part 2); a late payment passes the payment time.
 */
export function advancePeriod(from: Date, cycle: BillingCycle): Date {
  return addCalendarMonths(from, cycle === 'yearly' ? 12 : 1);
}

/** First instant of the current bulk-message window, stepping calendar
 *  months forward from the subscription anchor (`subStart`). Monthly quota
 *  resets each month on a yearly plan (Part 1) — anchored to subscription
 *  start, never rolls over. Bounded: a yearly plan walks at most 12 steps. */
export function currentWindowAnchor(subStart: Date, now: Date): Date {
  let anchor = new Date(subStart.getTime());
  // Walk back if now is somehow before the start (defensive, shouldn't
  // happen for an active sub); then forward while the NEXT boundary is
  // still at-or-before now.
  while (anchor > now) anchor = addCalendarMonths(anchor, -1);
  let next = addCalendarMonths(anchor, 1);
  let guard = 0;
  while (next <= now && guard < 1200) {
    anchor = next;
    next = addCalendarMonths(anchor, 1);
    guard += 1;
  }
  return anchor;
}

/** The `usage_counters.period_month` DATE key for the current window. */
export function windowMonthKey(subStart: Date, now: Date): string {
  const anchor = currentWindowAnchor(subStart, now);
  return anchor.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
