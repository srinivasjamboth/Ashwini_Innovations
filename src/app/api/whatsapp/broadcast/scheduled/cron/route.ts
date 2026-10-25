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
// Auth + shape mirror /api/automations/cron and /api/flows/cron: a GET
// guarded by the shared AUTOMATION_CRON_SECRET via `x-cron-secret`, run
// on any scheduler (Vercel Cron / GitHub Action / external pinger) every
// minute. Re-using that secret keeps operators to one value to set. This
// endpoint is only required for multi-instance deployments; a single
// self-hosted server fires schedules on its own via the instrumentation
// scheduler, with no external caller.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runScheduledBroadcasts } from '@/lib/whatsapp/scheduled-broadcast-cron';
import { ensureBroadcastSchedulerArmed } from '@/lib/whatsapp/broadcast-scheduler-arm';

// A full drain pass is sequential over recipients; give it the same
// ceiling the resume route uses.
export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare (length pre-check: timingSafeEqual throws on
  // unequal lengths). Only the length leaks, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
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
