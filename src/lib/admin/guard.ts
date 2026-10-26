/**
 * The one reusable admin guard.
 *
 * Authorization model:
 *   - Credentials: the owner proves their password ONCE at the admin
 *     login (Supabase), which then mints an opaque, admin-only marker
 *     cookie. From then on the marker — validated against the
 *     server-side session store — is the ONLY thing that authenticates
 *     an admin request. We deliberately never read the Supabase auth
 *     cookie here: it is shared with the client dashboard (Path=/), so
 *     relying on it would let an owner admin session double as a
 *     signed-in client session. Keeping the marker opaque and admin-
 *     scoped is what confines the owner account to /ashwini-control.
 *   - Authorization: owner-only, keyed on ADMIN_OWNER_USER_ID — an
 *     immutable auth uid in a SERVER-ONLY env var. No table column,
 *     no role flag, nothing any signup/invitation/API can write.
 *   - Fail closed: env var missing ⇒ everybody is denied (with a loud
 *     server-side warning), because "who is the owner" is unanswerable.
 *   - Denial shape: no live marker ⇒ redirect to the admin login;
 *     a marker bound to a non-owner (or an unconfigured owner) ⇒ 404 on
 *     pages / 404 JSON on APIs. The area must be indistinguishable
 *     from a nonexistent one to everyone else.
 *
 * Middleware alone is NOT sufficient — every admin page, layout, and
 * API route calls one of these functions itself.
 */

import { notFound, redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { ADMIN_LOGIN_PATH, ADMIN_OWNER_ENV_VAR, ADMIN_SESSION_COOKIE } from './constants'
import { resolveAdminMarker } from './session-store'

/** The owner's immutable auth uid, or null when unconfigured. */
export function getOwnerUserId(): string | null {
  const raw = process.env[ADMIN_OWNER_ENV_VAR]?.trim()
  if (!raw) {
    console.warn(
      `[admin] ${ADMIN_OWNER_ENV_VAR} is not set — Super Admin Dashboard access is DENIED for everyone (fail closed). ` +
        `Set it to the owner's auth.users UUID in the server environment.`,
    )
    return null
  }
  return raw
}

/**
 * Server-component / layout guard. Redirects to the admin login when
 * there is no live admin marker, 404s (identically to a missing page)
 * for a marker bound to anyone who isn't the configured owner, and
 * slides the marker's idle window on every call.
 */
export async function requireOwner(): Promise<{ userId: string; email: string }> {
  const marker = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value
  const identity = await resolveAdminMarker(marker)

  // No marker, or an expired one ⇒ back to the admin login. A client
  // token-holder walking straight into /ashwini-control lands here too,
  // because they hold no admin marker.
  if (!identity) redirect(ADMIN_LOGIN_PATH)

  const ownerId = getOwnerUserId()
  if (!ownerId || identity.userId !== ownerId) {
    // A marker that somehow points at a non-owner (or the owner env is
    // unset): respond exactly like a nonexistent page — no hint it exists.
    notFound()
  }

  return { userId: identity.userId, email: identity.email }
}

/**
 * API-route guard. Never throws away the request shape: returns a
 * ready-to-send rejection (401 when there is no session, 404 when the
 * caller simply doesn't belong here) or the authenticated owner.
 * Data-bearing responses must additionally carry Cache-Control:
 * no-store (each route sets that explicitly).
 */
export async function requireOwnerApi(): Promise<
  { ok: true; userId: string; markerId: string | undefined } | { ok: false; response: NextResponse }
> {
  const deny = (status: 401 | 404, body: unknown) => ({
    ok: false as const,
    response: NextResponse.json(body, {
      status,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' },
    }),
  })

  const markerId = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value
  const identity = await resolveAdminMarker(markerId)

  // No live admin marker ⇒ 401 (the caller isn't in an admin session).
  if (!identity) return deny(401, { error: 'unauthorized' })

  const ownerId = getOwnerUserId()
  if (!ownerId || identity.userId !== ownerId) {
    // Marker bound to a non-owner (or owner env unset): same generic
    // shape as a missing route — no admin data, no hint.
    return deny(404, { error: 'not_found' })
  }

  return { ok: true, userId: identity.userId, markerId }
}
