// ============================================================
// POST /api/whatsapp/broadcast/[id]/cancel
//
// Cancels a scheduled broadcast before it fires. One conditional UPDATE
// (`WHERE status = 'scheduled'`) does two jobs:
//
//   - It scopes the write to the caller's account and to broadcasts that
//     are genuinely still waiting (drafts, sent and in-flight campaigns
//     are untouched — cancelling a mid-send broadcast would orphan the
//     recipients the browser tab is still working).
//   - It races the scheduler cron safely. The cron claims a row by
//     flipping 'scheduled' → 'sending' atomically; whichever of the two
//     UPDATEs lands first wins, and a cancel that arrives after the cron
//     already fired matches zero rows and is rejected rather than
//     pretending to have un-sent real messages.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: updated, error } = await supabase
      .from('broadcasts')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .select('id');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!updated || updated.length === 0) {
      // Distinguish "not yours / not there" from "already fired" so the UI
      // can say the right thing.
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
          error: `This broadcast is no longer scheduled (status: ${existing.status}) and cannot be cancelled.`,
          code: 'not_scheduled',
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true, broadcast_id: id, status: 'cancelled' });
  } catch (error) {
    console.error('Error in broadcast cancel POST:', error);
    return toErrorResponse(error);
  }
}
