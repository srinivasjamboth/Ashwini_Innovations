import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clearAccountPhoneNumbers } from '@/lib/whatsapp/phone-numbers'

/**
 * Resolve the caller's account_id from their profile — same minimal
 * helper the config route uses, kept local so this endpoint has no
 * shared-state coupling with POST/DELETE /api/whatsapp/config.
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * POST /api/whatsapp/disconnect
 *
 * Disconnects the account's WhatsApp connection: clears the stored
 * credentials (access token, phone number ID, WABA ID, verify token)
 * by removing the whatsapp_config row, which flips every status
 * consumer — this settings page, the inbox gate, the webhook — to
 * "not connected" on the next read.
 *
 * Deliberately does NOT touch historical data: chats/messages,
 * message templates, contacts and broadcast logs all live in their
 * own tables keyed by account_id. The only FK cascade involving
 * whatsapp_config points INTO it from accounts, so removing this row
 * cascades nothing. Reconnecting later does not resurrect old rows,
 * but none of them are deleted either.
 *
 * RLS on whatsapp_config (migration 017) restricts DELETE to account
 * admins/owners; when zero rows come back we surface that as a 403
 * instead of silently pretending success.
 */
export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // `.select('id')` makes the delete return the removed rows, so we
    // can tell "no config existed" / "RLS blocked the delete" (0 rows)
    // apart from a genuine disconnect.
    const { data: deleted, error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)
      .select('id')

    if (deleteError) {
      console.error('Error deleting whatsapp_config on disconnect:', deleteError)
      return NextResponse.json(
        { error: 'Failed to disconnect WhatsApp' },
        { status: 500 },
      )
    }

    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        {
          error:
            'No active WhatsApp connection found for this account, or you do not have permission to disconnect it.',
        },
        { status: 403 },
      )
    }

    // Disconnecting clears EVERY synced number under the WABA, not
    // just the active one (migration 047 catalog). Logged, never
    // fatal — the config row is already gone.
    await clearAccountPhoneNumbers(supabase, accountId)

    return NextResponse.json({ success: true, disconnected: true })
  } catch (error) {
    console.error('Error in WhatsApp disconnect POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
