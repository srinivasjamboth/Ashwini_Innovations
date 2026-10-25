import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAdminThrottleForTests,
  isLockedOut,
  registerFailure,
  registerSuccess,
  type ThrottleKey,
} from './throttle';
import { LOGIN_LOCK_BASE_MS, LOGIN_LOCK_MAX_MS } from './constants';

// Spec §2.5 + §8: six wrong passwords trigger the lockout, with an
// increasing backoff per email and per IP. Times are injected so the
// exponential ladder and the decay window are exercised without
// sleeping.

const EMAIL: ThrottleKey = { kind: 'email', value: 'Owner@Example.com ' };
const EMAIL_NORMALIZED: ThrottleKey = { kind: 'email', value: 'owner@example.com' };
const IP: ThrottleKey = { kind: 'ip', value: '203.0.113.7' };

beforeEach(() => {
  __resetAdminThrottleForTests();
});

describe('admin login throttle — per email', () => {
  it('allows the first five failures without locking', () => {
    let now = 0;
    for (let i = 1; i <= 5; i++) {
      expect(isLockedOut(EMAIL, now).locked).toBe(false);
      now += 1000;
      registerFailure(EMAIL, now);
    }
  });

  it('locks the sixth attempt after five failures (spec verification §8)', () => {
    let now = 1_000;
    for (let i = 0; i < 5; i++) {
      registerFailure(EMAIL, now);
      now += 1000;
    }
    const state = isLockedOut(EMAIL, now);
    expect(state.locked).toBe(true);
    expect(state.retryInMs).toBeGreaterThan(0);
    expect(state.retryInMs).toBeLessThanOrEqual(LOGIN_LOCK_BASE_MS);
  });

  it('normalizes case and surrounding whitespace — Owner@Example.com IS owner@example.com', () => {
    let now = 1_000;
    for (let i = 0; i < 5; i++) {
      registerFailure(EMAIL, now);
      now += 1000;
    }
    expect(isLockedOut(EMAIL_NORMALIZED, now).locked).toBe(true);
  });

  it('doubles the window on every failure past the threshold, capped', () => {
    let now = 1_000;
    for (let i = 0; i < 5; i++) {
      registerFailure(EMAIL, now);
      now += 1000;
    }
    // 5th failure → locked ~1 min.
    expect(isLockedOut(EMAIL, now).retryInMs).toBeLessThanOrEqual(LOGIN_LOCK_BASE_MS);

    registerFailure(EMAIL, now); // 6th
    expect(isLockedOut(EMAIL, now + 1000).retryInMs).toBeLessThanOrEqual(LOGIN_LOCK_BASE_MS * 2);

    registerFailure(EMAIL, now + 1000); // 7th → 4 min
    registerFailure(EMAIL, now + 2000); // 8th → 8 min
    registerFailure(EMAIL, now + 3000); // 9th → capped at LOGIN_LOCK_MAX_MS
    const late = isLockedOut(EMAIL, now + 4000).retryInMs;
    expect(late).toBeLessThanOrEqual(LOGIN_LOCK_MAX_MS);
    expect(late).toBeGreaterThan(LOGIN_LOCK_BASE_MS * 4);
  });

  it('decays after quiet: five fresh failures on a dormant key unlock nothing early', () => {
    let now = 1_000;
    for (let i = 0; i < 5; i++) {
      registerFailure(EMAIL, now);
      now += 1000;
    }
    expect(isLockedOut(EMAIL, now).locked).toBe(true);

    // Two hours of silence (well past the decay window).
    now += 2 * 60 * 60 * 1000;
    expect(isLockedOut(EMAIL, now).locked).toBe(false);

    // Strikes restart from zero: four failures still don't lock.
    for (let i = 0; i < 4; i++) {
      now += 1000;
      registerFailure(EMAIL, now);
    }
    expect(isLockedOut(EMAIL, now + 1000).locked).toBe(false);
  });

  it('a success clears the slate entirely', () => {
    let now = 1_000;
    for (let i = 0; i < 5; i++) {
      registerFailure(EMAIL, now);
      now += 1000;
    }
    registerSuccess(EMAIL);
    expect(isLockedOut(EMAIL, now).locked).toBe(false);
  });
});

describe('admin login throttle — per IP', () => {
  it('tracks independently from the email counter', () => {
    let now = 1_000;
    for (let i = 0; i < 5; i++) {
      registerFailure(EMAIL, now);
      now += 1000;
    }
    // Email is locked, the IP (threshold 10) is not.
    expect(isLockedOut(EMAIL, now).locked).toBe(true);
    expect(isLockedOut(IP, now).locked).toBe(false);
  });

  it('locks once its own (higher) threshold is crossed', () => {
    let now = 1_000;
    for (let i = 0; i < 10; i++) {
      registerFailure(IP, now);
      now += 1000;
    }
    expect(isLockedOut(IP, now).locked).toBe(true);
  });
});
