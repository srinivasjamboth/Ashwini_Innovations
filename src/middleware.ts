import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import {
  ADMIN_LOGIN_PATH,
  ADMIN_SESSION_COOKIE,
  IMPERSONATION_BLOCKED_APIS,
  IMPERSONATION_BLOCKED_PAGES,
  IMPERSONATION_BLOCKED_REDIRECT,
} from '@/lib/admin/constants'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Super Admin area (/ashwini-control). Two jobs here, both at the
  // edge of the admin subtree:
  //   1. shape the denial for logged-out visitors — they bounce to
  //      the admin login. (Owner-vs-customer authorization is NOT
  //      decided here — requireOwner() in lib/admin/guard is the
  //      authority, enforced again in every layout/page/API; a
  //      signed-in non-owner passing this check still gets a 404.)
  //   2. stamp no-index / no-cache / framing headers on EVERY admin
  //      response, including the login page and admin API routes.
  //
  // The gate keys on the admin MARKER cookie, not the Supabase session:
  // an owner admin session no longer carries a Supabase auth cookie at
  // all (that would leak into the client app), so the marker is the only
  // honest "this browser is in the admin area" signal. Presence is enough
  // here — validity/idle/expiry is enforced again by requireOwner().
  if (
    request.nextUrl.pathname === '/ashwini-control' ||
    request.nextUrl.pathname.startsWith('/ashwini-control/')
  ) {
    const isAdminLogin = request.nextUrl.pathname === ADMIN_LOGIN_PATH
    const hasAdminMarker = request.cookies.has(ADMIN_SESSION_COOKIE)
    let adminResponse: NextResponse
    if (!hasAdminMarker && !isAdminLogin) {
      const url = request.nextUrl.clone()
      url.pathname = ADMIN_LOGIN_PATH
      url.search = ''
      adminResponse = withRefreshedCookies(NextResponse.redirect(url))
    } else {
      adminResponse = supabaseResponse
    }
    adminResponse.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet')
    adminResponse.headers.set('Cache-Control', 'no-store, max-age=0')
    adminResponse.headers.set('Pragma', 'no-cache')
    adminResponse.headers.set('X-Frame-Options', 'DENY')
    adminResponse.headers.set('X-Content-Type-Options', 'nosniff')
    adminResponse.headers.set('Referrer-Policy', 'no-referrer')
    adminResponse.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
    return adminResponse
  }

  // The platform owner's credentials belong to the Super Admin Dashboard
  // ONLY — never the client app. If an owner somehow presents a client
  // Supabase session on a main-app route, drop that session (clear the
  // shared sb-* auth cookies) and send them to the admin login. Fail-safe:
  // when ADMIN_OWNER_USER_ID isn't visible to this runtime the check is a
  // no-op, so it can never lock out ordinary customers.
  const ownerId = process.env.ADMIN_OWNER_USER_ID?.trim()
  if (user && ownerId && user.id === ownerId) {
    const url = request.nextUrl.clone()
    url.pathname = ADMIN_LOGIN_PATH
    url.search = ''
    const res = NextResponse.redirect(url)
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith('sb-')) res.cookies.set(c.name, '', { path: '/', maxAge: 0 })
    }
    return res
  }

  // Login-as-user: an admin marker cookie riding along WITH a live
  // customer session means this browser is the Super Admin viewing a
  // customer account. Credential-changing and money-touching surfaces
  // (password/email change, API keys, checkout/renew — see the lists in
  // lib/admin/constants) are denied for the whole view; everything else
  // behaves normally so the admin sees what the customer sees.
  //
  // The check is marker PRESENCE, not validity: middleware cannot reach
  // the Node-only marker store, and validity is irrelevant to safety
  // here — only a session minted through requireOwnerApi() can produce
  // this cookie pair, and a customer who forges a junk marker cookie at
  // themselves loses access to their own settings, nothing more. Page
  // denials redirect (a human lands somewhere usable); API denials
  // answer a plain 403 the customer UI shows as its generic error.
  if (user && request.cookies.has(ADMIN_SESSION_COOKIE)) {
    const pathname = request.nextUrl.pathname
    if (IMPERSONATION_BLOCKED_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      const url = request.nextUrl.clone()
      const [path, query] = IMPERSONATION_BLOCKED_REDIRECT.split('?')
      url.pathname = path
      url.search = query ? `?${query}` : ''
      return withRefreshedCookies(NextResponse.redirect(url))
    }
    if (IMPERSONATION_BLOCKED_APIS.some((p) => pathname.startsWith(p))) {
      return withRefreshedCookies(
        NextResponse.json(
          { error: 'impersonation_blocked' },
          { status: 403, headers: { 'Cache-Control': 'no-store' } },
        ),
      )
    }
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  // Every top-level route under src/app/(dashboard)/ belongs here —
  // middleware.test.ts reads that directory and fails on a missing one.
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/templates', '/broadcasts', '/automations', '/flows', '/forms', '/agents', '/notifications', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  // Webhooks (verified by signature upstream) and scheduler-cron endpoints
  // (guarded by their own shared secret inside the route) arrive WITHOUT a
  // user session — Meta for webhooks, and on Vercel a Cron Job sending
  // `Authorization: Bearer $CRON_SECRET`. Exempt both so the edge doesn't
  // 401 the request before the route can check its secret. The cron route
  // fails closed on its own if no secret is configured.
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook') &&
      !request.nextUrl.pathname.endsWith('/cron')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
