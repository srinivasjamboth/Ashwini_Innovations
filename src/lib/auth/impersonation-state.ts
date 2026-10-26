/**
 * Impersonation resolver — the ONLY customer-side reader of the admin
 * marker cookie. The dashboard layout calls it to decide whether to
 * render the "Super Admin is viewing" banner; nothing in the customer
 * app changes behaviour otherwise (an impersonated session is an
 * ordinary session — the denials live in middleware).
 *
 * Resolution needs BOTH halves of the impersonation fingerprint:
 *   1. a LIVE admin marker bound to the owner (same store + timeouts
 *      the admin area itself uses — presence alone is never trusted),
 *      read via resolveAdminMarker. Importing the admin store from a
 *      server component is safe: it is server-only and backed by the
 *      durable admin_session_markers table, so the layout sees the exact
 *      same markers the admin API routes minted — even on separate
 *      serverless functions, where an in-process store could not.
 *   2. a Supabase session whose user is a customer, NOT the owner —
 *      the owner's own session on main-app routes is wiped by
 *      middleware long before this runs; checking again here keeps the
 *      banner honest even if that wipe ever lags.
 *
 * Cost: zero in the common case (no marker ⇒ return before any auth
 * call). getUser() only runs for an admin-marker browser, and a
 * server-component cookie write failing (token refresh) is already the
 * accepted pattern of lib/supabase/server.ts — middleware refreshes.
 */

import { cookies } from 'next/headers'
import { ADMIN_OWNER_ENV_VAR, ADMIN_SESSION_COOKIE } from '@/lib/admin/constants'
import { resolveAdminMarker } from '@/lib/admin/session-store'
import { createClient } from '@/lib/supabase/server'

export interface ImpersonationState {
  /** The customer whose account is being viewed (session email). */
  customerEmail: string | null
}

export async function getImpersonationState(): Promise<ImpersonationState | null> {
  const marker = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value
  if (!marker) return null

  const identity = await resolveAdminMarker(marker)
  if (!identity) return null

  const ownerId = process.env[ADMIN_OWNER_ENV_VAR]?.trim()
  if (!ownerId || identity.userId !== ownerId) return null

  const { data } = await (await createClient()).auth.getUser()
  const user = data.user
  if (!user || user.id === ownerId) return null

  return { customerEmail: user.email ?? null }
}
