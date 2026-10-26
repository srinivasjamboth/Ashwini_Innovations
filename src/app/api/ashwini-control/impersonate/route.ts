/**
 * POST /api/ashwini-control/impersonate — "Login as user".
 *
 * Mints a real customer session (lib/admin/impersonation) and hands it
 * ONLY to the owner's own browser, which plants it as sb-* cookies and
 * navigates into the customer app. Gated by, in order:
 *   1. CSRF same-origin check (same primitive as admin login/logout),
 *   2. requireOwnerApi() — a live, store-validated admin marker bound
 *      to the owner uid (this is the authority; middleware never is),
 *   3. a per-owner rate limit, so even a stolen marker can't be used to
 *      mass-mint sessions across the customer base quietly.
 *
 * The response carries raw session tokens, so it is strict no-store +
 * no-robots, and the body is never logged. Exit lives client-side
 * (banner → signOut local): the admin marker cookie is not touched by
 * anything here, so the owner returns to /ashwini-control still signed
 * in.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi, getOwnerUserId } from '@/lib/admin/guard'
import { mintCustomerSession } from '@/lib/admin/impersonation'
import { sameOriginOrMissing } from '@/lib/admin/csrf'
import { checkRateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const NO_STORE: HeadersInit = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

/** Per-owner mint budget: generous for support work, loud for abuse. */
const MINT_LIMIT = { limit: 12, windowMs: 5 * 60_000 }

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOriginOrMissing(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE })
  }

  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  let userId = ''
  try {
    const body = (await request.json()) as { userId?: unknown }
    userId = typeof body.userId === 'string' ? body.userId : ''
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE })
  }
  if (!userId.trim()) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE })
  }

  const limit = checkRateLimit(`adminImpersonate:${auth.userId}`, MINT_LIMIT)
  if (!limit.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))) },
      },
    )
  }

  const ownerId = getOwnerUserId()
  if (!ownerId) {
    // requireOwnerApi already fail-closed on this; belt-and-suspenders
    // so the mint can never run with an undefined exclusion set.
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE })
  }

  const result = await mintCustomerSession(userId, ownerId)
  if (!result.ok) {
    // Generic on purpose: existence hints stay inside the owner's own
    // console via nothing at all — the ledger UI already shows the row.
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE })
  }

  return NextResponse.json(
    {
      ok: true,
      customer: { email: result.customerEmail },
      session: result.session,
    },
    { headers: NO_STORE },
  )
}

/** A bare GET on the API endpoint is not a route — 405, no information. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: NO_STORE })
}
