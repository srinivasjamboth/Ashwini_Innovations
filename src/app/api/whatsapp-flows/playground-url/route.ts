import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { resolvePlaygroundLink } from '@/lib/whatsapp/flows-service';

/**
 *   GET /api/whatsapp-flows/playground-url
 *
 * Where the "Build in Playground" / "Open Playground" buttons point.
 *
 * The answer comes from the server on purpose: whether the link can be
 * scoped to this account's business depends on which ids the WhatsApp
 * connection actually captured, and Meta's tooling URLs change faster
 * than their messaging API. Keeping the construction here means the next
 * review of that decision is one file, not every button in the app.
 *
 * See `resolvePlaygroundLink` for why scoping is not offered today.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const link = await resolvePlaygroundLink(supabase, accountId);
    return NextResponse.json(link);
  } catch (error) {
    return toErrorResponse(error);
  }
}
