/**
 * POST /api/ashwini-control/users — Super Admin "Add New User".
 *
 * Guards stacked per spec Part 4/5: requireOwnerApi → CSRF → rate limit →
 * schema validation → create via the auth admin API (which runs the same
 * signup triggers). Owner-only, never cached. The password is validated
 * server-side and never written to logs; it is returned exactly once to
 * the creating admin so the panel can show it (spec Part 4).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { sameOriginOrMissing } from '@/lib/admin/csrf'
import { clientIpFrom } from '@/lib/admin/audit'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createUserViaAdminApi, validateNewUser } from '@/lib/admin/create-user'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  if (!sameOriginOrMissing(request)) {
    return NextResponse.json({ error: 'cross_origin' }, { status: 403, headers: HEADERS })
  }

  const limit = checkRateLimit(`admin-create-user:${auth.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: HEADERS })
  }

  const validated = validateNewUser(body)
  if (!validated.ok) {
    return NextResponse.json({ error: 'validation', fieldErrors: validated.fieldErrors }, { status: 400, headers: HEADERS })
  }

  const result = await createUserViaAdminApi(validated.value)
  if (result.kind === 'emailTaken') {
    return NextResponse.json({ error: 'email_taken' }, { status: 409, headers: HEADERS })
  }
  if (result.kind === 'failed') {
    return NextResponse.json({ error: result.message }, { status: 500, headers: HEADERS })
  }

  // Server-side audit (spec: tag writes with the admin id). No password.
  console.info(
    `[admin-audit] user_created admin=${auth.userId} new_user=${result.userId} email=${result.email} ip=${clientIpFrom(request.headers) ?? 'unknown'}`,
  )

  // Echo back everything the panel needs to confirm — including the
  // password the admin just set, so it can be shown ONCE with a copy
  // button and a "won't be shown again" note. It is never stored in the
  // ledger and never returned on any later read.
  return NextResponse.json(
    {
      ok: true,
      userId: result.userId,
      fullName: result.fullName,
      email: result.email,
      password: validated.value.password,
    },
    { headers: HEADERS },
  )
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: HEADERS })
}
