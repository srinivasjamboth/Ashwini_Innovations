// ============================================================
// GET /api/whatsapp/broadcast/scheduled/cron
//
// The scheduler. Fires any broadcast whose status is 'scheduled' and
// whose `scheduled_at` has arrived — browser open or closed, user online
// or not. This is what makes scheduling real rather than a tab that has
// to stay open (the dashboard's own send loop can't do that).
//
// It reuses the exact server-side machinery built for resume (issue
// #472): planBroadcastResume reads the frozen recipient rows,
// deliverBroadcast fans them out through Meta, finalizeBroadcastStatus
// settles the terminal status. No new fan-out, no duplicate send risk —
// the claim is one conditional UPDATE, so overlapping cron invocations
// (and a manual Resume, which locks the same row) can't both fire it.
//
// Auth + shape mirror /api/automations/cron and /api/flows/cron: a GET
// guarded by the shared AUTOMATION_CRON_SECRET via `x-cron-secret`, run
// on any scheduler (Vercel Cron / GitHub Action / external pinger) every
// minute. Re-using that secret keeps operators to one value to set.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkLimit, getEntitlements, incrementUsage } from '@/lib/plans/entitlements';
import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';

// A full drain pass is sequential over recipients; give it the same
// ceiling the resume route uses.
export const maxDuration = 300;

// How many due broadcasts one tick claims, and how many 1 000-recipient
// passes each may take before we hand the rest to a Resume click. A
// scheduled send is server-owned, so a generous cap keeps ordinary
// audiences fully offline-firing in one tick.
const DUE_PER_TICK = 25;
const MAX_PASSES_PER_BROADCAST = 20;

interface DueRow {
  id: string;
  account_id: string;
  header_media_url: string | null;
}

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

  const admin = supabaseAdmin();
  const now = new Date();

  const { data: due, error } = await admin
    .from('broadcasts')
    .select('id, account_id, header_media_url')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(DUE_PER_TICK);

  if (error) {
    console.error('[broadcast-scheduler] due scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return NextResponse.json({ fired: 0 });
  }

  let fired = 0;
  let skippedExpired = 0;
  let skippedQuota = 0;
  for (const row of due as DueRow[]) {
    // Plan enforcement (Part 3/4): a scheduled send fires server-side with no
    // user in the loop, so the checks the interactive path gets for free must
    // happen here. An EXPIRED account never sends (leave the row 'scheduled'
    // so it runs once the plan is renewed). Before spending any sends, the
    // full recipient batch is pre-checked against the bulk quota, mirroring
    // the interactive broadcast route.
    const ent = await getEntitlements(row.account_id);
    if (ent.effectiveStatus === 'expired') {
      skippedExpired++;
      continue;
    }
    const { count: pendingNow } = await admin
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', row.id)
      .eq('status', 'pending');
    if ((pendingNow ?? 0) > 0) {
      const bulk = await checkLimit(row.account_id, 'bulk_messages', pendingNow ?? 0);
      if (!bulk.allowed) {
        skippedQuota++;
        continue;
      }
    }

    // Claim: flip 'scheduled' → 'sending' AND take the delivery lock in
    // ONE conditional UPDATE. Only this tick wins; a concurrent tick or a
    // manual Resume sees a non-'scheduled' row and skips it. This is the
    // duplicate-send guarantee — a WhatsApp message can't be recalled.
    const { data: claimed } = await admin
      .from('broadcasts')
      .update({ status: 'sending', delivery_locked_at: now.toISOString() })
      .eq('id', row.id)
      .eq('account_id', row.account_id)
      .eq('status', 'scheduled')
      .select('id');

    if (!claimed || claimed.length === 0) continue;
    fired++;

    try {
      // Drain in capped passes so a large audience still completes inside
      // one tick. deliverBroadcast finalizes after every pass; while
      // recipients remain pending the status stays 'sending'.
      for (let pass = 0; pass < MAX_PASSES_PER_BROADCAST; pass++) {
        let res;
        try {
          res = await planBroadcastResume(admin, row.account_id, row.id, 'pending');
        } catch (e) {
          // Backlog cleared — this scheduled send is done.
          if (e instanceof BroadcastError && e.code === 'nothing_to_resume') break;
          throw e;
        }
        // Reproduce the browser pass's media-header override, if any.
        // Additive: rows without one (or text-header templates) leave
        // messageParams undefined and send exactly as the resume path does.
        if (row.header_media_url) {
          const mp = { headerMediaUrl: row.header_media_url };
          for (const planned of res.plan.planned) planned.messageParams = mp;
        }
        await deliverBroadcast(admin, res.plan);
        // 0 means this pass covered every remaining sendable recipient.
        if (res.remaining === 0) break;
      }
      // Settle whatever is left (also catches the fully-done case).
      await finalizeBroadcastStatus(admin, row.id);
    } catch (err) {
      // Never leave a claimed campaign wedged mid-flight.
      console.error(
        `[broadcast-scheduler] delivery failed for ${row.id}:`,
        err instanceof BroadcastError ? err.message : err,
      );
      await finalizeBroadcastStatus(admin, row.id).catch(() => {});
    } finally {
      await releaseBroadcastDelivery(admin, row.id).catch(() => {});
    }

    // Record the recipients that ACTUALLY reached Meta this tick (Part 4:
    // increment by the number actually sent). The row is now terminal, so it
    // won't be re-claimed — this counts each scheduled send exactly once.
    const { count: sentCount } = await admin
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', row.id)
      .eq('status', 'sent');
    if ((sentCount ?? 0) > 0) {
      await incrementUsage(row.account_id, 'bulk_messages', sentCount ?? 0);
    }
    fired++;
  }

  return NextResponse.json({ fired, skippedExpired, skippedQuota });
}
