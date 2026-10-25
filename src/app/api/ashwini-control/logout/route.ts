/**
 * Super Admin logout.
 *
 * POST-only, CSRF-checked, and guarded: you can only end an admin
 * session you actually hold. Clears the admin marker cookie (live '/'
 * path + the legacy page-scoped path from earlier builds) and forgets
 * it in the session store. There is deliberately NO Supabase signOut
 * here — the admin area never issued a shared auth cookie in the first
 * place, so an admin logout has nothing to end in the client app.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { revokeAdminMarker } from '@/lib/admin/session-store'
import { sameOriginOrMissing } from '@/lib/admin/csrf'
import { ADMIN_ROOT, ADMIN_SESSION_COOKIE, ADMIN_SESSION_COOKIE_LEGACY_PATH, ADMIN_SESSION_COOKIE_PATH } from '@/lib/admin/constants'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOriginOrMissing(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  revokeAdminMarker(auth.markerId)

  const response = NextResponse.json(
    { ok: true, redirect: ADMIN_ROOT },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    },
  )
  // Clear the marker at its live path ('/') …
  response.cookies.set(ADMIN_SESSION_COOKIE, '', {
    path: ADMIN_SESSION_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
  })
  // …plus the legacy page-scoped cookie from earlier builds. Raw
  // append, not a second cookies.set: response.cookies dedupes by
  // name, so only the last write per name is emitted.
  response.headers.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=${ADMIN_SESSION_COOKIE_LEGACY_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  )
  return response
}
