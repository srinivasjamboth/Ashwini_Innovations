// ============================================================
// POST /api/whatsapp/broadcast/[id]/reschedule
//
// Moves a not-yet-fired scheduled broadcast to a new date/time. Like
// cancel, it is a single conditional UPDATE scoped to status='scheduled'
// so it can't stomp on a campaign the cron has already claimed (that row
// is 'sending' by the time a reschedule races it, and matches zero rows).
//
// The audience + params are already frozen in broadcast_recipients, so
// rescheduling only changes WHEN it fires, never WHAT is sent — which is
// exactly the guarantee the resume path relies on (issue #472).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isFuture, ScheduleTimeError, zonedTimeToUtc } from '@/lib/whatsapp/schedule-time';

// Same floor as the schedule route — a reschedule to the past would fire
// on the next cron tick, which nobody means by "reschedule".
const MIN_LEAD_MS = 30 * 1000;

interface ReschedulePayload {
  // Preferred: the wall-clock parts + zone, converted server-side so the
  // DST math lives in one tested place rather than the browser.
  date?: string;
  time?: string;
  timezone?: string;
  // Accepted: a precomputed ISO instant (kept for API callers).
  scheduled_at?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ReschedulePayload;

    let when: Date;
    try {
      if (body.date && body.time) {
        when = zonedTimeToUtc(body.date, body.time, body.timezone ?? 'UTC');
      } else if (body.scheduled_at) {
        when = new Date(body.scheduled_at);
        if (Number.isNaN(when.getTime())) throw new ScheduleTimeError('Invalid scheduled_at');
      } else {
        return NextResponse.json(
          { error: 'Provide a new date and time, or a scheduled_at instant' },
          { status: 400 },
        );
      }
    } catch (err) {
      const message =
        err instanceof ScheduleTimeError ? err.message : 'Invalid schedule date/time';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (!isFuture(when) || when.getTime() - Date.now() < MIN_LEAD_MS) {
      return NextResponse.json(
        { error: 'The new time must be in the future.' },
        { status: 400 },
      );
    }

    const { data: updated, error } = await supabase
      .from('broadcasts')
      .update({
        scheduled_at: when.toISOString(),
        scheduled_tz: body.timezone ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .select('id');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!updated || updated.length === 0) {
      const { data: existing } = await supabase
        .from('broadcasts')
        .select('status')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!existing) {
        return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
      }
      return NextResponse.json(
        {
          error: `Only a scheduled broadcast can be rescheduled (status: ${existing.status}).`,
          code: 'not_scheduled',
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      success: true,
      broadcast_id: id,
      scheduled_at: when.toISOString(),
    });
  } catch (error) {
    console.error('Error in broadcast reschedule POST:', error);
    return toErrorResponse(error);
  }
}
