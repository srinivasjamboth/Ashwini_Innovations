/**
 * /api/ashwini-control/vault/[subscriptionId]
 *
 *  GET   — subscription detail (plan + limits/features + customer +
 *          history), computed by lib/admin/vault from real tables.
 *  PATCH — the ONE write operation in the admin area (spec Part 4).
 *          Guards stacked per Part 4.5: requireOwnerApi → CSRF →
 *          rate limit → schema validation → optimistic concurrency
 *          (updated_at token ⇒ 409) → the single-transaction RPC.
 *          The customer's cached entitlements are invalidated inside
 *          applyVaultUpdate so limits change without re-login.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { sameOriginOrMissing } from '@/lib/admin/csrf'
import { clientIpFrom } from '@/lib/admin/audit'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { dayEndExclusiveUtcMs } from '@/lib/admin/vault'
import {
  applyVaultUpdate,
  getVaultDetail,
  validateVaultUpdate,
  type VaultUpdateResult,
} from '@/lib/admin/vault'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = { params: Promise<{ subscriptionId: string }> }

export async function GET(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  const { subscriptionId } = await ctx.params
  if (!UUID_RE.test(subscriptionId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
  }

  try {
    const detail = await getVaultDetail(auth.userId, subscriptionId)
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
    return NextResponse.json(detail, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] vault detail failed:', err)
    return NextResponse.json({ error: 'vault_unavailable' }, { status: 500, headers: HEADERS })
  }
}

export async function PATCH(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  // CSRF — same rule as the admin login/logout POSTs.
  if (!sameOriginOrMissing(request)) {
    return NextResponse.json({ error: 'cross_origin' }, { status: 403, headers: HEADERS })
  }

  // Rate limit — bound a scripted stampede of writes; the admin
  // action budget (30/min) is far above any legitimate click-through.
  const limit = checkRateLimit(`admin-vault-update:${auth.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const { subscriptionId } = await ctx.params
  if (!UUID_RE.test(subscriptionId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: HEADERS })
  }

  // The panel sends the date input verbatim ("YYYY-MM-DD"). Interpret
  // it as end-of-day in the admin timezone so the chosen day counts
  // as fully subscribed (inclusive expiry), same boundary math the
  // list filters use.
  const raw = (body ?? {}) as Record<string, unknown>
  if (typeof raw.periodEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.periodEnd)) {
    const endMs = dayEndExclusiveUtcMs(raw.periodEnd)
    if (endMs === null) {
      return NextResponse.json(
        { fieldErrors: { periodEnd: 'Invalid expiry date.' } },
        { status: 400, headers: HEADERS },
      )
    }
    raw.periodEnd = new Date(endMs).toISOString()
  }

  const validated = validateVaultUpdate(raw)
  if (!validated.ok) {
    return NextResponse.json({ fieldErrors: validated.fieldErrors }, { status: 400, headers: HEADERS })
  }

  const ip = clientIpFrom(request.headers)

  let result: VaultUpdateResult
  try {
    result = await applyVaultUpdate(auth.userId, subscriptionId, validated.value, ip)
  } catch (err) {
    console.error('[admin-api] vault update failed:', err)
    return NextResponse.json({ error: 'update_failed' }, { status: 500, headers: HEADERS })
  }

  switch (result.kind) {
    case 'ok':
      return NextResponse.json({ row: result.row }, { headers: HEADERS })
    case 'conflict':
      // 409: the row moved underneath the panel (e.g. a payment
      // webhook). The panel reloads the latest data.
      return NextResponse.json({ error: result.message }, { status: 409, headers: HEADERS })
    case 'notFound':
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
    case 'schemaMissing':
      return NextResponse.json(
        {
          error: 'migrations_missing',
          hint: 'Apply supabase/migrations/048_plans_billing.sql and 049_admin_vault.sql to enable subscription updates.',
        },
        { status: 503, headers: HEADERS },
      )
    case 'rpcError':
      // RPC-side last-line validation (the TS schema already covers
      // these — surfacing them keeps the two layers honest).
      return NextResponse.json({ fieldErrors: { form: result.error } }, { status: 400, headers: HEADERS })
    default:
      return NextResponse.json({ error: result.message ?? 'update_failed' }, { status: 500, headers: HEADERS })
  }
}
