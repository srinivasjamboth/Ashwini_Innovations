/**
 * Super Admin login — the ONLY way an admin-capable session comes to
 * exist. Hardened per spec §2:
 *
 *   - Email + password against the existing Supabase credentials
 *     system; no signup / recovery / social paths here by design.
 *   - Rate-limit per IP (shared fixed-window limiter) plus escalating
 *     lockouts per email AND per IP (lib/admin/throttle).
 *   - Every failure — bad password, unknown email, valid-but-not-the-
 *     owner credentials, locked-out, CSRF-rejected — answers with the
 *     same generic "Invalid credentials". Nothing here ever says why.
 *   - Owner check happens BEFORE any session cookie is persisted: the
 *     Supabase client runs against an isolated in-memory cookie jar,
 *     so a non-owner's successful password match produces no browser
 *     state at all (we just discard the jar).
 *   - Every attempt (including throttled ones) lands a row in the
 *     insert-only admin_login_events table. Passwords are never
 *     stored, logged, or echoed anywhere.
 *   - Success issues ONLY an owner-bound admin marker cookie (httpOnly,
 *     Path=/ so it reaches the /api/ashwini-control/* routes, SameSite=
 *     Lax, Secure in production) driving the 60-min idle / 8-h absolute
 *     timeouts enforced by requireOwner(). The Supabase auth cookies are
 *     deliberately NOT written to the browser — they are shared with the
 *     client dashboard, so releasing them would silently sign the owner
 *     into the main app too. That is the whole point of the marker model.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { checkRateLimit } from '@/lib/rate-limit'
import { getOwnerUserId } from '@/lib/admin/guard'
import { clientIpFrom, recordLoginAttempt } from '@/lib/admin/audit'
import { sameOriginOrMissing } from '@/lib/admin/csrf'
import {
  isLockedOut,
  registerFailure,
  registerSuccess,
  type ThrottleKey,
} from '@/lib/admin/throttle'
import { createAdminMarker } from '@/lib/admin/session-store'
import {
  ADMIN_LOGIN_GENERIC_ERROR,
  ADMIN_ROOT,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_LEGACY_PATH,
  ADMIN_SESSION_COOKIE_MAXAGE_S,
  ADMIN_SESSION_COOKIE_PATH,
  LOGIN_IP_RATE_LIMIT,
} from '@/lib/admin/constants'

export const dynamic = 'force-dynamic'

const NO_STORE: HeadersInit = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

/** The one and only failure shape. */
function deny(status: 401 | 429): NextResponse {
  return NextResponse.json(
    { error: ADMIN_LOGIN_GENERIC_ERROR },
    { status, headers: NO_STORE },
  )
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOriginOrMissing(request)) return deny(401)

  let email = ''
  let password = ''
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown }
    email = typeof body.email === 'string' ? body.email : ''
    password = typeof body.password === 'string' ? body.password : ''
  } catch {
    return deny(401)
  }
  if (!email.trim() || !password) return deny(401)

  const ip = clientIpFrom(request.headers) ?? 'unknown'
  const emailKey: ThrottleKey = { kind: 'email', value: email }
  const ipKey: ThrottleKey = { kind: 'ip', value: ip }

  // Coarse per-IP budget first, then the escalating lockouts. A
  // throttled attempt is still an attempt — it gets an audit row and
  // the same generic answer.
  const budget = checkRateLimit(`adminLogin:${ip}`, LOGIN_IP_RATE_LIMIT)
  const emailLock = isLockedOut(emailKey)
  const ipLock = isLockedOut(ipKey)
  if (!budget.success || emailLock.locked || ipLock.locked) {
    await recordLoginAttempt({ attemptedEmail: email, success: false, headers: request.headers })
    const retrySec = Math.ceil(
      Math.max(emailLock.retryInMs, ipLock.retryInMs, budget.reset - Date.now()) / 1000,
    )
    return NextResponse.json(
      { error: ADMIN_LOGIN_GENERIC_ERROR },
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, retrySec)) },
      },
    )
  }

  // Isolated cookie jar: Supabase's setAll writes land in this array
  // and NOWHERE else. Only an owner-verified login flushes them to the
  // browser response — which is precisely "verify the owner identity
  // before persisting any session."
  let jar: Array<{ name: string; value: string; options: Record<string, unknown> }> = []
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => jar as { name: string; value: string; options?: Record<string, unknown> }[],
        setAll: (cookies) => {
          jar = cookies as unknown as typeof jar
        },
      },
    },
  )

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.user) {
    registerFailure(emailKey)
    registerFailure(ipKey)
    await recordLoginAttempt({ attemptedEmail: email, success: false, headers: request.headers })
    return deny(401)
  }

  // Password matched — but authorization is owner-only. A valid
  // customer credential gets the identical rejection and NO session.
  const user = data.user
  const ownerId = getOwnerUserId()
  const confirmed = Boolean(
    (user as { email_confirmed_at?: string | null }).email_confirmed_at ??
      (user as { confirmed_at?: string | null }).confirmed_at,
  )
  if (!ownerId || user.id !== ownerId || !confirmed) {
    // Discard the jar (nothing was persisted to the browser anyway);
    // also end the stray Supabase session this isolated sign-in
    // created server-side so it can't be replayed.
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
    registerFailure(emailKey)
    registerFailure(ipKey)
    await recordLoginAttempt({ attemptedEmail: email, success: false, headers: request.headers })
    return deny(401)
  }

  // Owner verified: mint the admin marker. Crucially we DO NOT release
  // the isolated Supabase auth cookies into the browser — that cookie is
  // shared with the client dashboard (Path=/), so flushing it would
  // silently sign the owner into the main app without them ever logging
  // in there. The opaque, admin-only marker is the sole admin credential;
  // the throwaway Supabase session this isolated sign-in created is ended
  // server-side so nothing is left to replay.
  registerSuccess(emailKey)
  registerSuccess(ipKey)
  await recordLoginAttempt({ attemptedEmail: email, success: true, headers: request.headers })
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)

  const markerId = createAdminMarker(user.id, user.email ?? '')
  const response = NextResponse.json(
    { ok: true, redirect: ADMIN_ROOT },
    { headers: NO_STORE },
  )
  response.cookies.set(ADMIN_SESSION_COOKIE, markerId, {
    // '/' — NOT ADMIN_ROOT: the APIs live under /api/ashwini-control/*,
    // and cookie Path matching is literal, so a /ashwini-control-scoped
    // marker is never sent to them (every dashboard fetch 401s).
    path: ADMIN_SESSION_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_SESSION_COOKIE_MAXAGE_S,
  })
  // Expire the old page-scoped cookie from earlier builds so the
  // browser can't carry two markers with the same name. MUST be a raw
  // header append: response.cookies dedupes by name (last write wins),
  // so a second cookies.set with the same name would silently EVICT the
  // live marker header above.
  response.headers.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=${ADMIN_SESSION_COOKIE_LEGACY_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  )
  return response
}

/** A bare GET on the API endpoint is not a route — 405 with the usual
 *  no-store hygiene, and no information either way. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: NO_STORE })
}
