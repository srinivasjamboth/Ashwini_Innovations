import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { firstScreenIdOf } from '@/lib/whatsapp/flow-json';
import type { PublishedFlowOption } from '@/types';

/**
 *   GET /api/whatsapp-flows/published
 *
 * Lightweight list for the Template Builder's Form dropdown.
 *
 * Published-only, deliberately: Meta refuses a template whose FLOW button
 * points at a DRAFT (and at a Flow it rejected), so offering anything else
 * would build a template that fails at submit time — the worst place to
 * discover it, because the rejection arrives as a pending review rather
 * than an error. Rows without a `meta_flow_id` are excluded for the same
 * reason: locally we cannot prove to Meta that anything exists.
 *
 * `flow_json` is read here only to derive the entry screen id, which a
 * FLOW button needs as `navigate_screen`, and is then dropped — the
 * dropdown ships a few hundred bytes per row either way.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');

    const { data, error } = await supabase
      .from('whatsapp_flows')
      .select('id, name, meta_flow_id, flow_json')
      .eq('account_id', accountId)
      .eq('status', 'published')
      .not('meta_flow_id', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const flows: PublishedFlowOption[] = (data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      meta_flow_id: row.meta_flow_id as string,
      first_screen: firstScreenIdOf(
        (row.flow_json as { screens?: unknown } | null)?.screens,
      ),
    }));

    return NextResponse.json({ flows });
  } catch (error) {
    return toErrorResponse(error);
  }
}
