import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  FLOW_SELECT,
  FlowJsonRejectedError,
  MetaRejectedFlowError,
  WhatsAppNotConfiguredError,
  createWhatsAppFlow,
} from '@/lib/whatsapp/flows-service';
import type { WhatsAppFlow } from '@/types';

/**
 * WhatsApp Forms/Flows — list + create.
 *
 *   GET  /api/whatsapp-flows      — every Form this account has created
 *   POST /api/whatsapp-flows      — validate, create + publish on Meta, store
 *
 * Tenancy: every query goes through the RLS-scoped client from
 * `requireRole` *and* filters on `account_id` explicitly. The second one
 * is not redundant — it means a policy regression shows up as an empty
 * list rather than another account's Forms.
 */

export async function GET() {
  try {
    // Read-only listing; a viewer may look but may not publish (RLS on
    // whatsapp_flows keeps INSERT at 'admin').
    const { supabase, accountId } = await requireRole('viewer');

    const { data, error } = await supabase
      .from('whatsapp_flows')
      // `flow_json` is deliberately not selected: the list page renders
      // name/status/screens/created, and a Flow JSON is routinely tens of
      // KB per row.
      .select(FLOW_SELECT)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ flows: (data ?? []) as WhatsAppFlow[] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    // Creating a Form is a write against the connected WABA that RLS
    // cannot undo, so it sits at the same tier as template submission.
    const { supabase, accountId, userId } = await requireRole('admin');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const input = (body ?? {}) as { name?: unknown; flow_json?: unknown };
    const name = typeof input.name === 'string' ? input.name : '';
    const flowJsonText = typeof input.flow_json === 'string' ? input.flow_json : '';

    const flow = await createWhatsAppFlow({
      supabase,
      accountId,
      userId,
      name,
      flowJsonText,
    });

    return NextResponse.json({ flow }, { status: 201 });
  } catch (error) {
    if (error instanceof FlowJsonRejectedError) {
      // Our structural pre-check — the panel localises `issue` and shows
      // it under the textarea, so this never reaches Meta.
      return NextResponse.json(
        { error: error.message, issue: error.issue },
        { status: 400 },
      );
    }
    if (error instanceof WhatsAppNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MetaRejectedFlowError) {
      // Meta refused, and we stored why. 422 (not 500) because the
      // request was well-formed and is worth re-sending after a fix — and
      // the row is carried so the panel can show `error_message` inline
      // instead of a generic failure toast.
      return NextResponse.json(
        {
          error: error.message,
          issue: 'meta_rejected',
          flow: error.flow,
        },
        { status: 422 },
      );
    }
    console.error('Error creating WhatsApp Flow:', error);
    return toErrorResponse(error);
  }
}
