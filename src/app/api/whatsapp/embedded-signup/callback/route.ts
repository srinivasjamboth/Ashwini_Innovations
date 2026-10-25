import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  debugTokenScopes,
  exchangeEmbeddedSignupCode,
  listWabaPhoneNumbers,
} from '@/lib/whatsapp/meta-api'
import { discoverAccountWabaIds } from '@/lib/whatsapp/phone-numbers'

/**
 * POST /api/whatsapp/embedded-signup/callback
 *
 * Server half of Meta's Embedded Signup. The browser runs the FB JS SDK
 * flow (see components/settings/whatsapp-embedded-signup.tsx) and, once
 * the customer finishes, hands back a short-lived `code` plus the WABA /
 * phone-number ids that the SDK surfaced in its `WA_EMBEDDED_SIGNUP`
 * message event.
 *
 * This endpoint does exactly ONE thing: exchange that `code` for the
 * customer's business token via the server-to-server
 * `GET /oauth/access_token` call (it carries META_APP_SECRET, so it can
 * never run in the browser), and echo back the asset ids.
 *
 * It deliberately does NOT write the `whatsapp_config` row. The client
 * takes the returned `{ access_token, phone_number_id, waba_id }` and
 * posts them to the EXISTING POST /api/whatsapp/config, which performs
 * the same verify / register / subscribe / encrypt / upsert-by-account_id
 * it always has. That is what guarantees both connection paths converge
 * on the same record and the same connected state — and that a
 * Meta-signup over an existing manual config UPDATEs the row rather than
 * duplicating it (the same UNIQUE(account_id) upsert "Reconnect WhatsApp"
 * already relies on).
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: { code?: unknown; phone_number_id?: unknown; waba_id?: unknown } = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const phoneNumberId =
      typeof body.phone_number_id === 'string' ? body.phone_number_id.trim() : null
    const wabaId = typeof body.waba_id === 'string' ? body.waba_id.trim() : null

    if (!code) {
      return NextResponse.json({ error: 'code is required' }, { status: 400 })
    }

    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      return NextResponse.json(
        {
          error:
            'Embedded Signup is not configured on this instance. Set META_APP_ID and META_APP_SECRET (plus the NEXT_PUBLIC_ values on the client), or use manual configuration.',
        },
        { status: 500 },
      )
    }

    let accessToken: string
    try {
      accessToken = await exchangeEmbeddedSignupCode({ appId, appSecret, code })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Code exchange failed'
      console.error('[whatsapp/embedded-signup/callback] code exchange failed:', message)
      return NextResponse.json(
        { error: 'Could not complete the Meta connection. The signup code may have expired — please try again.' },
        { status: 502 },
      )
    }

    // Diagnostic: what did Meta actually grant this token? Portfolio
    // discovery (finding numbers under OTHER WABAs/portfolios) needs
    // business_management; without that grant the old numbers are
    // unreachable no matter how the sync code is written. Log it and
    // echo it so the browser console carries the same evidence.
    let grantedScopes: string[] = []
    try {
      grantedScopes = await debugTokenScopes({ appId, appSecret, accessToken })
      console.log('[whatsapp/embedded-signup/callback] granted scopes:', grantedScopes.join(', '))
    } catch (err) {
      console.error('[whatsapp/embedded-signup/callback] debug_token failed:', err)
    }

    // Existing-number support: when Meta's FINISH reported only a WABA
    // (the customer connected an account whose numbers were registered
    // earlier, not a freshly created one), offer the client a picker.
    // Portfolio-wide: the old verified numbers usually live under a
    // DIFFERENT WABA than the one the signup session landed on, so walk
    // every sibling account the token can see, not just the session's.
    // Each entry carries the waba_id that owns it — the client must
    // save the pair together, POST /api/whatsapp/config validates that
    // the number belongs to the WABA it is submitted with.
    type PickerNumber = {
      id: string
      display_phone_number?: string
      verified_name?: string
      waba_id: string
    }
    const phoneNumbers: PickerNumber[] = []
    if (!phoneNumberId && wabaId) {
      try {
        const wabaIds = await discoverAccountWabaIds({ wabaId, accessToken })
        for (const w of wabaIds) {
          try {
            const nums = await listWabaPhoneNumbers({ wabaId: w, accessToken })
            for (const n of nums) {
              phoneNumbers.push({
                id: n.id,
                display_phone_number: n.display_phone_number,
                verified_name: n.verified_name,
                waba_id: w,
              })
            }
          } catch (err) {
            // One unreachable sibling must never blank the whole picker.
            console.error('[whatsapp/embedded-signup/callback] list failed for WABA', w, err)
          }
        }
      } catch (err) {
        // Non-fatal — the client falls back to asking for manual entry.
        console.error('[whatsapp/embedded-signup/callback] list numbers failed:', err)
      }
    }

    // Return shaped exactly like the manual form's payload so the client
    // can reuse POST /api/whatsapp/config unchanged.
    return NextResponse.json({
      success: true,
      access_token: accessToken,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      phone_numbers: phoneNumbers,
      granted_scopes: grantedScopes,
    })
  } catch (error) {
    console.error('Error in WhatsApp embedded-signup callback:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
