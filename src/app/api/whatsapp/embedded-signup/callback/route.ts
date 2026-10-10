import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { exchangeEmbeddedSignupCode } from '@/lib/whatsapp/meta-api'

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

    // Return shaped exactly like the manual form's payload so the client
    // can reuse POST /api/whatsapp/config unchanged.
    return NextResponse.json({
      success: true,
      access_token: accessToken,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
    })
  } catch (error) {
    console.error('Error in WhatsApp embedded-signup callback:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
