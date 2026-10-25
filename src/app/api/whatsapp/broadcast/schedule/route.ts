// ============================================================
// POST /api/whatsapp/broadcast/schedule
//
// Creates a SCHEDULED broadcast: the audience + per-recipient template
// params are resolved on the client (reusing use-broadcast-sending's
// resolution — the same code the "send now" path runs) and frozen here
// into `broadcast_recipients` rows with the parent left in status
// 'scheduled'. Nothing is sent on this request; the scheduler cron
// (./scheduled/cron) fires it at `scheduled_at`, browser open or not.
//
// Kept deliberately thin and additive:
//   - Same 'agent' gate as every other broadcast write (viewers read-only).
//   - Same RLS-scoped client the dashboard already uses for its own
//     broadcast INSERTs, so no new service-role surface.
//   - Server-side date validation, because a schedule in the past would
//     fire instantly and can't be recalled.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkFeature } from '@/lib/plans/entitlements';
import { ensureBroadcastSchedulerArmed } from '@/lib/whatsapp/broadcast-scheduler-arm';
import { SCHEDULE_MIN_LEAD_MS } from '@/lib/whatsapp/schedule-time';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface ScheduledRecipient {
  contact_id: string;
  template_params?: string[];
}

interface SchedulePayload {
  name?: string;
  template_name?: string;
  template_language?: string;
  scheduled_at?: string;
  timezone?: string;
  header_media_url?: string | null;
  template_variables?: Record<string, unknown>;
  audience_filter?: Record<string, unknown>;
  recipients?: ScheduledRecipient[];
}

// A schedule row is a plan, not a send — recipients are inserted in
// batches like the create path. Bound the request generously.
const INSERT_BATCH_SIZE = 200;
// Never honour a schedule that is effectively "now" — that's a Send Now,
// and an accidental past date would fire on the next cron tick. The SAME
// window the wizard enforces (lib/whatsapp/schedule-time), so a pick the
// client green-lights is never rejected here.
const MIN_LEAD_MS = SCHEDULE_MIN_LEAD_MS;

export async function POST(request: Request) {
  let createdBroadcastId: string | null = null;
  // Held for the catch-block rollback: an unexpected throw after the
  // parent INSERT still needs to clean the orphan up.
  let userClient: SupabaseClient | null = null;

  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    userClient = supabase;

    // Arm the in-process scheduler in whatever server is handling this
    // request. register() (instrumentation) does not run under `next dev`,
    // so arming from this hot write path guarantees a due broadcast actually
    // fires on a self-hosted single server without an external pinger.
    ensureBroadcastSchedulerArmed();

    const limit = checkRateLimit(
      `broadcast-schedule:${userId}`,
      RATE_LIMITS.broadcast,
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Plan enforcement (Part 4): the Broadcast Scheduler is a plan FEATURE,
    // not a count — Growth and above only. Blocked here so a Starter user
    // can't schedule via a direct request even though the UI hides the tab;
    // the actual bulk-message quota is charged when the cron fires the send.
    const sched = await checkFeature(accountId, 'broadcast_scheduler');
    if (!sched.allowed) return NextResponse.json(sched, { status: 403 });

    const body = (await request.json()) as SchedulePayload;
    const {
      name,
      template_name,
      template_language,
      scheduled_at,
      timezone,
      header_media_url,
      template_variables,
      audience_filter,
      recipients,
    } = body;

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Broadcast name is required' }, { status: 400 });
    }
    if (!template_name) {
      return NextResponse.json({ error: 'template_name is required' }, { status: 400 });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { error: 'A scheduled broadcast needs at least one recipient' },
        { status: 400 },
      );
    }
    // Every recipient must reference a real contact the caller can see;
    // an empty/invalid id would FK-fail the batch insert anyway, so reject
    // it up front with a clear message.
    if (recipients.some((r) => !r || typeof r.contact_id !== 'string' || !r.contact_id)) {
      return NextResponse.json(
        { error: 'Every recipient needs a contact_id' },
        { status: 400 },
      );
    }

    const when = scheduled_at ? new Date(scheduled_at) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return NextResponse.json(
        { error: 'Provide a valid scheduled_at date and time' },
        { status: 400 },
      );
    }
    const leadMs = when.getTime() - Date.now();
    if (leadMs < MIN_LEAD_MS) {
      return NextResponse.json(
        { error: 'Scheduled time must be in the future. Use Send Now for an immediate broadcast.' },
        { status: 400 },
      );
    }

    // Parent first (status 'scheduled'). Count columns stay trigger-owned
    // (migrations 003/005) — never seeded here.
    const { data: broadcast, error: broadcastError } = await supabase
      .from('broadcasts')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: name.trim(),
        template_name,
        template_language: template_language ?? 'en_US',
        template_variables: template_variables ?? {},
        audience_filter: audience_filter ?? {},
        scheduled_at: when.toISOString(),
        scheduled_tz: timezone ?? null,
        header_media_url: header_media_url ?? null,
        status: 'scheduled',
        total_recipients: recipients.length,
      })
      .select()
      .single();

    if (broadcastError || !broadcast) {
      return NextResponse.json(
        { error: `Failed to create scheduled broadcast: ${broadcastError?.message ?? 'unknown error'}` },
        { status: 500 },
      );
    }
    createdBroadcastId = broadcast.id as string;

    // Freeze recipients so the offline cron sends exactly what this pass
    // would have (same template_params contract as migration 038).
    for (let i = 0; i < recipients.length; i += INSERT_BATCH_SIZE) {
      const batch = recipients.slice(i, i + INSERT_BATCH_SIZE).map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contact_id,
        status: 'pending' as const,
        template_params: Array.isArray(r.template_params) ? r.template_params : [],
      }));
      const { error: recipientError } = await supabase
        .from('broadcast_recipients')
        .insert(batch);
      if (recipientError) {
        // Roll the parent back so no orphaned 'scheduled' campaign with a
        // partial audience survives — mirrors the atomicity issue #370
        // fixed for the API path.
        await supabase.from('broadcasts').delete().eq('id', broadcast.id);
        createdBroadcastId = null;
        return NextResponse.json(
          { error: `Failed to save scheduled recipients: ${recipientError.message}` },
          { status: 500 },
        );
      }
    }

    return NextResponse.json(
      { success: true, broadcast_id: broadcast.id, scheduled_at: when.toISOString() },
      { status: 201 },
    );
  } catch (error) {
    // A partial failure after the parent landed — remove it so nothing
    // half-created is left for the cron to trip over.
    if (createdBroadcastId && userClient) {
      await userClient.from('broadcasts').delete().eq('id', createdBroadcastId);
    }
    console.error('Error in broadcast schedule POST:', error);
    return toErrorResponse(error);
  }
}
