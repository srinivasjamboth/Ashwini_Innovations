// ============================================================
// GET /api/whatsapp/broadcast/scheduled/cron
//
// The HTTP entry point for the scheduler. Fires any broadcast whose status
// is 'scheduled' and whose `scheduled_at` has arrived — browser open or
// closed, user online or not. This is what makes scheduling real rather
// than a tab that has to stay open (the dashboard's own send loop can't
// do that).
//
// The delivery logic itself lives in runScheduledBroadcasts() — the SAME
// core the in-process scheduler (src/instrumentation.ts) runs — so the two
// paths can never diverge. Running both is safe: each campaign is claimed
// with one conditional UPDATE, so overlapping invocations can't double-send.
//
// Auth accepts TWO paths so the same endpoint works on every host:
//   1. `x-cron-secret: <AUTOMATION_CRON_SECRET>` — GitHub Action / curl / any
//      external pinger (shared with /api/automations/cron and /api/flows/cron).
//   2. `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron Jobs send
//      automatically on each scheduled hit. On Vercel there is NO always-on
//      process, so the in-process instrumentation scheduler is inert; this
//      external cron (declared in vercel.json) IS the scheduler trigger.
// A deployment only needs the secret matching its pinger to be set.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runScheduledBroadcasts } from '@/lib/whatsapp/scheduled-broadcast-cron';
import { ensureBroadcastSchedulerArmed } from '@/lib/whatsapp/broadcast-scheduler-arm';

// A full drain pass is sequential over recipients; give it the same
// ceiling the resume route uses.
export const maxDuration = 300;

/**
 * Constant-time secret compare. Length pre-check because timingSafeEqual
 * throws on unequal lengths; only the length leaks, which isn't sensitive.
 */
function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const automationSecret = process.env.AUTOMATION_CRON_SECRET;
  const vercelCronSecret = process.env.CRON_SECRET;
  if (!automationSecret && !vercelCronSecret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  // Either header authorizes: the shared x-cron-secret (external pingers)
  // or Vercel's Authorization: Bearer <CRON_SECRET> (Vercel Cron Jobs).
  const headerSecret = request.headers.get('x-cron-secret') ?? '';
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';

  const authorized =
    secretMatches(headerSecret, automationSecret) ||
    secretMatches(bearer, vercelCronSecret);
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // A pinger calling this endpoint also arms the local in-process loop, so
    // intermittent external calls keep the server self-sufficient between them.
    ensureBroadcastSchedulerArmed();
    const summary = await runScheduledBroadcasts();
    return NextResponse.json(summary);
  } catch (err) {
    // runScheduledBroadcasts already logged the scan failure; surface a
    // generic 500 without echoing the raw message to an anonymous caller.
    console.error('[broadcast-scheduler] cron run failed:', err);
    return NextResponse.json({ error: 'cron run failed' }, { status: 500 });
  }
}
