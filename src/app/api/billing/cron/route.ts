import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { expireOverdueSubscriptions } from '@/lib/plans/billing';
import { reconcileStaleOrders } from '@/lib/plans/reconcile';
import { razorpayConfigured } from '@/lib/plans/gateway/razorpay';

/**
 * GET|POST /api/billing/cron  — expiry sweep + order reconciliation.
 *
 * Part 3: the cron "flips the stored status for tidiness." Enforcement never
 * waits for this — effective status is computed at request time — but running
 * it keeps subscriptions.status honest for the admin dashboard and reports.
 *
 * It is ALSO the reconciliation safety net (spec PART 3.5): every run checks
 * still-open Razorpay orders older than 5 minutes against the gateway and
 * activates any that are paid, covering missed webhooks and closed browser
 * windows. The gateway sweep is skipped when Razorpay isn't configured.
 *
 * Guarded by the same shared secret as the other crons in this app. Auth
 * accepts TWO paths so the endpoint works on every host, exactly like the
 * broadcast scheduler cron:
 *   1. `x-cron-secret: <AUTOMATION_CRON_SECRET>` — external pinger / curl.
 *   2. `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron Jobs send on
 *      each scheduled hit (see vercel.json: /api/billing/cron runs every 10
 *      minutes, which is the reconciliation trigger on Vercel, where there is
 *      no always-on process).
 */
export const maxDuration = 60;

/** Constant-time compare; length pre-check because timingSafeEqual throws on
 *  unequal lengths (only the length leaks, which is not sensitive). */
function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request) {
  const automationSecret = process.env.AUTOMATION_CRON_SECRET;
  const vercelCronSecret = process.env.CRON_SECRET;
  if (!automationSecret && !vercelCronSecret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const headerSecret = request.headers.get('x-cron-secret') ?? '';
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const authorized =
    secretMatches(headerSecret, automationSecret) || secretMatches(bearer, vercelCronSecret);
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const flipped = await expireOverdueSubscriptions(new Date());
    // Reconcile paid-but-unactivated orders through the ONE idempotent
    // fulfilment. Never let a gateway hiccup fail the expiry sweep, and never
    // run it without keys configured.
    let reconciled = null;
    if (razorpayConfigured()) {
      try {
        reconciled = await reconcileStaleOrders();
      } catch (err) {
        console.error('[billing/cron] reconcile failed:', err);
      }
    }
    return NextResponse.json({ flipped, reconciled });
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
