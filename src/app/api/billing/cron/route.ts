import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { expireOverdueSubscriptions } from '@/lib/plans/billing';

/**
 * GET|POST /api/billing/cron  — expiry sweep.
 *
 * Part 3: the cron "flips the stored status for tidiness." Enforcement never
 * waits for this — effective status is computed at request time — but running
 * it keeps subscriptions.status honest for the admin dashboard and reports.
 *
 * Guarded by the same shared secret as the other crons in this app
 * (AUTOMATION_CRON_SECRET) via the x-cron-secret header.
 */
async function handle(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const flipped = await expireOverdueSubscriptions(new Date());
    return NextResponse.json({ flipped });
  } catch (err) {
    console.error('[billing/cron] failed:', err);
    return NextResponse.json({ error: 'cron run failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
