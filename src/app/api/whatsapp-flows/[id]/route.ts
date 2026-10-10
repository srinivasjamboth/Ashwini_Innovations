import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  FLOW_SELECT,
  WhatsAppNotConfiguredError,
  deleteWhatsAppFlow,
} from '@/lib/whatsapp/flows-service';
import type { WhatsAppFlow } from '@/types';

/**
 *   GET    /api/whatsapp-flows/:id — one Form (includes `flow_json`)
 *   DELETE /api/whatsapp-flows/:id — remove it, and the DRAFT on Meta
 *
 * `flow_json` is only returned here, never on the list route: the Forms
 * page needs it to show/resubmit a definition, while a list would carry
 * tens of KB per row for nothing.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole('viewer');

    const { data, error } = await supabase
      .from('whatsapp_flows')
      .select(`${FLOW_SELECT}, flow_json`)
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      // Not found and not-yours answer the same way — confirming which
      // ids exist under another account is an information leak.
      return NextResponse.json({ error: 'Form not found.' }, { status: 404 });
    }
    return NextResponse.json({ flow: data as WhatsAppFlow });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // Mirrors the INSERT/DELETE policy on whatsapp_flows: publishing and
    // unpublishing a Form is an admin action.
    const { supabase, accountId } = await requireRole('admin');

    await deleteWhatsAppFlow(supabase, accountId, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof WhatsAppNotConfiguredError) {
      // A DRAFT cannot be removed from Meta without credentials, and we
      // refuse to drop the local row and orphan it. Say so plainly.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'Form not found.') {
      return NextResponse.json({ error: 'Form not found.' }, { status: 404 });
    }
    console.error('Error deleting WhatsApp Flow:', error);
    return toErrorResponse(error);
  }
}
