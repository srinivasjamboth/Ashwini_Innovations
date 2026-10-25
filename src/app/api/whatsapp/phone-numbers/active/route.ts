import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { setActivePhoneNumber } from '@/lib/whatsapp/phone-numbers'
import { subscribeWabaToApp } from '@/lib/whatsapp/meta-api'

/**
 * POST /api/whatsapp/phone-numbers/active  (admin+)
 *
 * Switches which synced WABA number the account sends with. Flips
 * `is_active` in the catalog (migration 047) and mirrors the id onto
 * whatsapp_config.phone_number_id — the field the send paths and the
 * inbound webhook already key on — so switching here changes
 * everything downstream with zero changes elsewhere.
 *
 * Body: { phone_number_id: string }
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-phone-active:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const phoneNumberId =
      typeof body?.phone_number_id === 'string' ? body.phone_number_id.trim() : ''
    if (!/^\d+$/.test(phoneNumberId)) {
      return NextResponse.json(
        { error: 'A numeric phone_number_id is required.' },
        { status: 400 },
      )
    }

    const result = await setActivePhoneNumber({
      admin: supabaseAdmin(),
      accountId,
      phoneNumberId,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // The active number may live under a SIBLING WABA of the same
    // portfolio (migration 047 multi-WABA sync). Inbound events are
    // delivered per-WABA, so best-effort subscribe the newly-active
    // number's WABA to this app. Idempotent; a failure here must never
    // undo a successful switch — sending already works off the shared
    // business token — so this is log-only.
    try {
      const admin = supabaseAdmin()
      const { data: cfg } = await admin
        .from('whatsapp_config')
        .select('waba_id, access_token')
        .eq('account_id', accountId)
        .maybeSingle()
      if (cfg?.waba_id && cfg.access_token) {
        await subscribeWabaToApp({
          wabaId: cfg.waba_id,
          accessToken: decrypt(cfg.access_token),
        })
      }
    } catch (err) {
      console.error('[whatsapp/phone-numbers/active] sibling subscribe failed (non-fatal):', err)
    }

    return NextResponse.json({ ok: true, phone_number_id: phoneNumberId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
