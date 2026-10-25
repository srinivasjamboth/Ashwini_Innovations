/**
 * Server-side admin session markers — the sole authority behind every
 * admin page/API.
 *
 * A marker is minted only when the owner check passes at login
 * (src/app/api/ashwini-control/login). Every admin page/API then
 * presents it via the ADMIN_SESSION_COOKIE httpOnly cookie; we verify
 * it here against this in-process map and read the owner identity
 * (uid + email) back out of it. The admin area is deliberately NOT
 * tied to the Supabase auth cookie — that cookie is shared with the
 * client dashboard (Path=/), so presenting it would silently sign the
 * owner into the main app too. The marker is an opaque, admin-only
 * token, which is what keeps the owner account out of the client app.
 *
 * Timeouts (both checked in resolveAdminMarker):
 *   - idle:      no seen-update for ADMIN_SESSION_IDLE_MS ⇒ expired
 *   - absolute:  older than ADMIN_SESSION_ABSOLUTE_MS     ⇒ expired
 *
 * Fail-closed properties worth knowing:
 *   - Map state is per Node process. A restart (or a redeploys on a
 *     multi-instance deploy) invalidates every admin marker, so the
 *     owner simply logs in again. Client sessions are untouched.
 *   - A marker is bound to the auth uid that minted it; presenting
 *     another user's cookie never validates.
 *
 * IMPORTANT: the Map lives on globalThis, NOT as a plain module
 * local. Next's server compiler can hand each route (the login API
 * vs the panel layout) its OWN instance of this module — with a
 * module-level Map the marker minted during login would be invisible
 * to every page request, and the owner would bounce back to the
 * login screen forever (observed in dev with Turbopack; same
 * per-route cloning can occur in production builds). globalThis is
 * shared by every module instance in the process, and survives dev
 * hot-reload of this file, which is also the desired behavior: the
 * owner's browser keeps presenting a marker the reloaded server can
 * still validate.
 */

import { randomUUID } from 'node:crypto'
import {
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_IDLE_MS,
} from './constants'

interface AdminMarker {
  userId: string
  /** Owner email captured at mint time — used for the greeting display
   *  so we never need a live Supabase session (or its shared cookie). */
  email: string
  createdAt: number
  lastSeenAt: number
}

// Process-wide singleton — see the module comment for why a plain
// `const markers = new Map()` here is NOT safe across route bundles.
type MarkerStore = Map<string, AdminMarker>
declare global {
  // eslint-disable-next-line no-var
  var __ashwiniAdminMarkers: MarkerStore | undefined
}
const markers: MarkerStore = (globalThis.__ashwiniAdminMarkers ??= new Map<string, AdminMarker>())

// Opportunistic cleanup so the Map can't grow unbounded under a
// brute-force login run (failed logins never mint markers, but a
// long-lived owner can collect one per day).
function sweepExpired(now: number) {
  for (const [id, m] of markers) {
    if (now - m.createdAt > ADMIN_SESSION_ABSOLUTE_MS) markers.delete(id)
  }
}

/** Mint a marker for a freshly verified owner login. */
export function createAdminMarker(userId: string, email: string): string {
  const id = randomUUID()
  const now = Date.now()
  if (markers.size % 50 === 0) sweepExpired(now)
  markers.set(id, { userId, email, createdAt: now, lastSeenAt: now })
  return id
}

/**
 * The admin area's single authentication primitive. Validates a
 * presented marker and returns the owner identity bound to it, sliding
 * the idle window on success. Returns null (and forgets the marker)
 * when it's unknown, idle-expired, or past the absolute timeout — the
 * caller maps null to "no admin session". Because identity comes from
 * this store, the admin area never reads the shared Supabase auth
 * cookie, so an owner admin session cannot leak into the client app.
 */
export function resolveAdminMarker(
  id: string | undefined,
): { userId: string; email: string } | null {
  if (!id) return null
  const marker = markers.get(id)
  if (!marker) return null

  const now = Date.now()
  if (
    now - marker.createdAt > ADMIN_SESSION_ABSOLUTE_MS ||
    now - marker.lastSeenAt > ADMIN_SESSION_IDLE_MS
  ) {
    markers.delete(id)
    return null
  }
  marker.lastSeenAt = now
  return { userId: marker.userId, email: marker.email }
}

/** Logout / forced eviction. */
export function revokeAdminMarker(id: string | undefined): void {
  if (id) markers.delete(id)
}

/** Test-only helper: clear all markers between unit tests. */
export function __resetAdminMarkersForTests(): void {
  markers.clear()
}
