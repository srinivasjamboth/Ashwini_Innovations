import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { MessageTemplate } from '@/types';

/**
 *   GET /api/automations/templates
 *
 * Approved templates for the Automation builder's Template node dropdown.
 *
 * Account-scoped and read through the server (RLS) client rather than a
 * direct browser → Supabase query, so it works for any signed-in account
 * member regardless of whether their email is confirmed — the exact
 * failure that left the picker empty. Mirrors the WhatsApp Form node's
 * `/api/whatsapp-flows/published` pattern: one server-side source of
 * truth per picker.
 *
 * APPROVED-only, deliberately: an automation SENDS the template, and Meta
 * rejects anything not yet approved at send time. Same filter as the
 * inbox + broadcast send pickers.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');

    const { data, error } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'APPROVED')
      .order('name');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ templates: (data ?? []) as MessageTemplate[] });
  } catch (error) {
    return toErrorResponse(error);
  }
}
