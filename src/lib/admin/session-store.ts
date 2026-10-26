/**
 * Server-side admin session markers — the sole authority behind every
 * admin page/API.
 *
 * A marker is minted only when the owner check passes at login
 * (src/app/api/ashwini-control/login). Every admin page/API then
 * presents it via the ADMIN_SESSION_COOKIE httpOnly cookie; we verify
 * it here against a DURABLE server-side store and read the owner
 * identity (uid + email) back out of it. The admin area is deliberately
 * NOT tied to the Supabase auth cookie — that cookie is shared with the
 * client dashboard (Path=/), so presenting it would silently sign the
 * owner into the main app too. The marker is an opaque, admin-only
 * token, which is what keeps the owner account out of the client app.
 *
 * WHY THE STORE IS IN POSTGRES (not an in-process Map)
 * The store used to be a module-level Map on globalThis. That is shared
 * by every route ONLY within a single Node process — which is why it
 * worked on a local dev server. On a serverless host (Vercel) the login
 * API and each admin page/API run in DIFFERENT function instances with
 * no shared memory, so a marker minted during login is invisible to the
 * very next request and the owner is bounced straight back to the login
 * screen. Persisting markers in the admin_session_markers table (reached
 * only through the service-role key via the SECURITY DEFINER functions
 * added in migration 050) gives every instance one shared source of
 * truth, so admin sessions survive across serverless functions.
 *
 * Timeouts (both enforced atomically inside admin_session_resolve):
 *   - idle:      no seen-update for ADMIN_SESSION_IDLE_MS ⇒ expired
 *   - absolute:  older than ADMIN_SESSION_ABSOLUTE_MS     ⇒ expired
 * Both windows are unchanged from the in-memory store; expiry is judged
 * against the database clock so no instance's clock skew can matter.
 *
 * Fail-closed properties worth knowing:
 *   - resolveAdminMarker returns null on ANY error (unknown marker,
 *     expired, or the DB call itself failing) — callers map null to
 *     "no admin session" and deny access. A database outage locks the
 *     admin area; it never opens it.
 *   - A marker is bound to the auth uid that minted it; presenting
 *     another user's cookie never validates.
 */

import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from './supabase-admin'
import {
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_IDLE_MS,
} from './constants'

/** Mint a marker for a freshly verified owner login. Returns the opaque
 *  marker id to set as the cookie. If the durable write fails we still
 *  return an id, but the subsequent resolve will fail closed (null) —
 *  a login that can't be persisted can never be used to enter the area. */
export async function createAdminMarker(
  userId: string,
  email: string,
): Promise<string> {
  const id = randomUUID()
  try {
    const { error } = await supabaseAdmin().rpc('admin_session_create', {
      p_id: id,
      p_user_id: userId,
      p_email: email,
    })
    if (error) console.error('[admin-session] create failed:', error.message)
  } catch (err) {
    console.error('[admin-session] create threw:', err)
  }
  return id
}

/**
 * The admin area's single authentication primitive. Validates a
 * presented marker against the durable store and returns the owner
 * identity bound to it, sliding the idle window on success. Returns
 * null (and forgets the marker) when it's unknown, idle-expired, or
 * past the absolute timeout — the caller maps null to "no admin
 * session". Because identity comes from this store, the admin area
 * never reads the shared Supabase auth cookie, so an owner admin
 * session cannot leak into the client app.
 */
export async function resolveAdminMarker(
  id: string | undefined,
): Promise<{ userId: string; email: string } | null> {
  if (!id) return null
  try {
    const { data, error } = await supabaseAdmin().rpc('admin_session_resolve', {
      p_id: id,
      p_idle_ms: ADMIN_SESSION_IDLE_MS,
      p_abs_ms: ADMIN_SESSION_ABSOLUTE_MS,
    })
    if (error) {
      console.error('[admin-session] resolve failed:', error.message)
      return null
    }
    if (!data) return null
    const obj = data as { userId?: string; email?: string }
    if (!obj.userId) return null
    return { userId: obj.userId, email: obj.email ?? '' }
  } catch (err) {
    console.error('[admin-session] resolve threw:', err)
    return null
  }
}

/** Logout / forced eviction. Best-effort: a failed delete only means the
 *  row lingers until its idle window lapses, which then fails closed. */
export async function revokeAdminMarker(id: string | undefined): Promise<void> {
  if (!id) return
  try {
    const { error } = await supabaseAdmin().rpc('admin_session_revoke', { p_id: id })
    if (error) console.error('[admin-session] revoke failed:', error.message)
  } catch (err) {
    console.error('[admin-session] revoke threw:', err)
  }
}
