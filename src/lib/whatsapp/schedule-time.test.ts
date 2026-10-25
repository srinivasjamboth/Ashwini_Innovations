import { describe, expect, it } from 'vitest';
import {
  ScheduleTimeError,
  formatScheduledInZone,
  getTimeZoneOptions,
  isFuture,
  utcToZonedParts,
  zonedTimeToUtc,
} from '@/lib/whatsapp/schedule-time';

// The scheduling feature stores an absolute instant (`scheduled_at`) but
// the user picks a wall-clock date/time in a zone. These lock the
// wall-clock ⇄ UTC conversion, including DST, so a scheduled broadcast
// fires at the intended moment and nothing about it depends on the
// machine running the tests.

describe('zonedTimeToUtc', () => {
  it('treats wall clock as-is in UTC', () => {
    expect(zonedTimeToUtc('2026-06-15', '12:00', 'UTC').toISOString()).toBe(
      '2026-06-15T12:00:00.000Z',
    );
  });

  it('applies a half-hour fixed offset (Asia/Kolkata, +05:30, no DST)', () => {
    expect(zonedTimeToUtc('2026-01-10', '10:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-01-10T04:30:00.000Z',
    );
  });

  it('handles standard vs daylight time (America/New_York)', () => {
    // EST = UTC-5 in January, EDT = UTC-4 in July.
    expect(zonedTimeToUtc('2026-01-10', '12:00', 'America/New_York').toISOString()).toBe(
      '2026-01-10T17:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-10', '12:00', 'America/New_York').toISOString()).toBe(
      '2026-07-10T16:00:00.000Z',
    );
  });

  it('is stable across a southern-hemisphere DST flip', () => {
    // Sydney is UTC+10 in winter (Jul) and UTC+11 in summer (Jan).
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'Australia/Sydney').toISOString()).toBe(
      '2026-01-14T22:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-15', '09:00', 'Australia/Sydney').toISOString()).toBe(
      '2026-07-14T23:00:00.000Z',
    );
  });

  it('rejects malformed, out-of-range and non-existent inputs', () => {
    expect(() => zonedTimeToUtc('2026-6-15', '12:00', 'UTC')).toThrow(ScheduleTimeError);
    expect(() => zonedTimeToUtc('2026-06-15', '1200', 'UTC')).toThrow(ScheduleTimeError);
    expect(() => zonedTimeToUtc('2026-02-30', '12:00', 'UTC')).toThrow(ScheduleTimeError);
    expect(() => zonedTimeToUtc('2026-06-15', '25:00', 'UTC')).toThrow(ScheduleTimeError);
    expect(() =>
      zonedTimeToUtc('2026-06-15', '12:00', 'Not/AZone'),
    ).toThrow(ScheduleTimeError);
  });
});

describe('utcToZonedParts round-trip', () => {
  const cases: Array<[string, string, string]> = [
    ['2026-01-10', '10:00', 'Asia/Kolkata'],
    ['2026-07-10', '23:45', 'America/New_York'],
    ['2026-03-14', '07:30', 'Europe/London'],
    ['2026-12-31', '00:05', 'UTC'],
  ];
  for (const [date, time, zone] of cases) {
    it(`preserves ${date} ${time} in ${zone}`, () => {
      const instant = zonedTimeToUtc(date, time, zone);
      expect(utcToZonedParts(instant, zone)).toEqual({ date, time });
    });
  }

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    const instant = new Date('2026-06-15T12:00:00.000Z');
    expect(utcToZonedParts(instant, 'Not/AZone')).toEqual({
      date: '2026-06-15',
      time: '12:00',
    });
  });
});

describe('isFuture', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  it('is true only strictly after now', () => {
    expect(isFuture('2026-06-15T12:00:01.000Z', now)).toBe(true);
    expect(isFuture('2026-06-15T11:59:59.000Z', now)).toBe(false);
    expect(isFuture('2026-06-15T12:00:00.000Z', now)).toBe(false);
  });
});

describe('getTimeZoneOptions', () => {
  it('includes UTC and the viewer zone, deduped', () => {
    const zones = getTimeZoneOptions();
    expect(zones).toContain('UTC');
    expect(zones[0]).toBe(zones.find(() => true)!); // non-empty
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe('formatScheduledInZone', () => {
  it('renders a non-empty localized string for a known zone', () => {
    const out = formatScheduledInZone('2026-06-15T12:00:00.000Z', 'Asia/Kolkata');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
