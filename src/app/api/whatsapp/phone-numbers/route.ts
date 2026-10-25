import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { syncAccountPhoneNumbers } from '@/lib/whatsapp/phone-numbers'

/**
 * GET /api/whatsapp/phone-numbers
 *
 * The account's synced WABA number catalog (migration 047) — every
 * number Meta lists under the connected WABA, not just the active
 * one. Plain DB read, RLS-scoped to account members; the status card
 * already receives the same list inside GET /api/whatsapp/config and
 * uses this when it needs a fresh copy without a health check.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('whatsapp_phone_numbers')
      .select('*')
      .eq('account_id', accountId)
      .order('is_active', { ascending: false })
      .order('display_phone_number', { ascending: true, nullsFirst: false })

    if (error) {
      console.error('[whatsapp/phone-numbers GET]', error)
      return NextResponse.json({ error: 'Failed to load phone numbers' }, { status: 500 })
    }

    return NextResponse.json({ phone_numbers: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/phone-numbers  (admin+)
 *
 * Re-fetch GET /{WABA_ID}/phone_numbers from Meta and reconcile the
 * catalog: numbers added in Business Manager since the last connect
 * appear, numbers removed there get soft-marked. Wired to the status
 * card's "Refresh status". A Meta failure returns ok:false with a
 * 502 — the connection status itself is untouched, and the catalog
 * keeps its last known state.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-phone-numbers-sync:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config || !config.waba_id) {
      return NextResponse.json(
        { error: 'No WhatsApp Business Account is connected to sync phone numbers from.' },
        { status: 400 },
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/phone-numbers POST] token decrypt failed:', err)
      return NextResponse.json(
        { error: 'The stored access token cannot be decrypted — reset and re-save the configuration.' },
        { status: 400 },
      )
    }

    const result = await syncAccountPhoneNumbers({
      admin: supabaseAdmin(),
      accountId,
      wabaId: config.waba_id,
      accessToken,
      activePhoneNumberId: config.phone_number_id,
    })

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error ?? 'Failed to sync phone numbers from Meta',
          // The catalog didn't change — surface whatever we still know.
          phone_numbers: [],
          sync_failed: true,
        },
        { status: 502 },
      )
    }

    return NextResponse.json({
      ok: true,
      phone_numbers: result.numbers,
      // Edge cases the UI prompts about: WABA lists zero numbers, or
      // the number the account sends with is no longer under it.
      empty: result.empty,
      active_missing: result.activeMissing,
      // How many WhatsApp Business Accounts Meta actually answered for.
      // 1 = portfolio discovery was not permitted for this token.
      wabas_scanned: result.wabasScanned.length,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
