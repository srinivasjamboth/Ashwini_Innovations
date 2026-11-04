import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getWabaBusiness } from '@/lib/whatsapp/meta-api'
import { buildMetaBillingUrl } from '@/lib/whatsapp/billing-link'

/**
 * GET /api/whatsapp/billing-link  (admin — same settings permission
 * the rest of the WhatsApp configuration uses)
 *
 * Returns the Meta Billing Hub URL for THIS account's connected
 * WhatsApp Business Account, so the URL format lives in exactly one
 * place server-side (src/lib/whatsapp/billing-link.ts).
 *
 * The portfolio id is read from whatsapp_config.business_id (migration
 * 061). When it is missing — manual connections and accounts created
 * before the column existed — it is resolved lazily from Meta
 * (GET /{waba_id}?fields=business) and cached back on the row, so the
 * Meta call happens at most once per account. Every failure path
 * degrades to the base Billing Hub URL rather than an error: the
 * customer must always be able to reach the page where they pay Meta.
 *
 * Tenant scoping is the RLS-scoped client from requireRole: the config
 * row is read by the caller's own account id, so another account's
 * ids can never surface here. No tokens go into the URL or the
 * response.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, business_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    const wabaId: string | null = config?.waba_id || null
    let businessId: string | null = config?.business_id || null

    // Lazy, cached backfill for connections that predate the column
    // (or never carried a portfolio id). Best-effort: any failure —
    // no token, decrypt error, Meta refusal — just leaves businessId
    // null and the base URL answers.
    if (!businessId && wabaId && config?.access_token) {
      try {
        const owners = await getWabaBusiness({
          wabaId,
          accessToken: decrypt(config.access_token),
        })
        const found = owners[0]?.id ?? null
        if (found) {
          businessId = found
          const { error: saveError } = await supabase
            .from('whatsapp_config')
            .update({ business_id: found })
            .eq('account_id', accountId)
          if (saveError) {
            // Cache write failed — the URL is still correct this call.
            console.warn('[whatsapp/billing-link] business_id cache write failed:', saveError.message)
          }
        }
      } catch (err) {
        console.error('[whatsapp/billing-link] owner business lookup failed:', err)
      }
    }

    return NextResponse.json({
      url: buildMetaBillingUrl({ businessId, wabaId }),
      // False = landed on the unscoped base (Meta will pick the
      // session's portfolio). The UI note about admin/finance access
      // covers both cases; nothing blocks on this flag today.
      scoped: Boolean(businessId),
      connected: Boolean(config?.waba_id || config?.phone_number_id),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
