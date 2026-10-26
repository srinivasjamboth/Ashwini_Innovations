/**
 * Login-as-user session minting — SERVER ONLY.
 *
 * The admin area is marker-authenticated and deliberately carries NO
 * Supabase session (see session-store.ts), so "open the app as this
 * customer" cannot be done by swapping identities inside an existing
 * session. Instead we mint a REAL, normal customer session the same way
 * the customer would get one by clicking an email magic link — minus the
 * email:
 *
 *   1. service-role `admin.getUserById(userId)` — existence + email +
 *      not-disabled checks against the same source of truth the login
 *      forms use.
 *   2. service-role `auth.admin.generateLink({type:'magiclink'})` —
 *      GoTrue issues a one-time login token HASH without sending any
 *      mail (the magicless flow from the Supabase docs).
 *   3. `auth.verifyOtp({token_hash, type:'magiclink'})` on the same
 *      service-role client — redeems that hash for a standard session
 *      (access + refresh tokens) bound to the CUSTOMER's auth uid.
 *
 * Properties this buys us:
 *   - The minted session is an ordinary customer session: RLS, the
 *     middleware refresh path, and every server route treat it exactly
 *     like the customer's own login. Nothing downstream needs to know
 *     impersonation exists.
 *   - The admin marker is untouched — Exit (client-side
 *     `signOut({scope:'local'})`) clears only the sb-* cookies, so the
 *     owner lands back in /ashwini-control still authenticated.
 *   - No password, no stored credential, no long-lived artifact: the
 *     tokens are the usual ~1 h access-token pair, and a normal logout
 *     (or natural expiry) ends the view.
 *
 * The returned tokens are handed ONLY to the owner's own browser (the
 * caller is gated by requireOwnerApi + CSRF + rate limit) over the
 * marker-authenticated response. They are never logged, never stored,
 * and never placed in any URL.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './supabase-admin'

/** Shape of the minted session handed to the admin browser. */
export interface MintedSession {
  access_token: string
  refresh_token: string
}

export type MintResult =
  | { ok: true; session: MintedSession; customerEmail: string }
  | { ok: false; status: 400 | 404 | 502; error: string }

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Mint a session for `userId`. Every failure answer is deliberately
 * generic (same 404 whether the uid doesn't exist, is disabled, or has
 * no email) — this endpoint must not become an oracle over auth.users.
 * `excludedUserId` refuses targets that must never be impersonated
 * (the owner's own uid — impersonating the owner would collide with
 * the middleware's owner-session wipe).
 */
export async function mintCustomerSession(
  userId: string,
  excludedUserId: string,
  client: SupabaseClient = supabaseAdmin(),
): Promise<MintResult> {
  const id = userId.trim()
  if (!UUID_RE.test(id)) return { ok: false, status: 400, error: 'invalid_target' }
  if (id === excludedUserId) return { ok: false, status: 400, error: 'invalid_target' }

  const { data: fetched, error: fetchError } = await client.auth.admin.getUserById(id)
  // A service-role outage must not look like "no such user" to the UI,
  // but neither may it leak anything about the account.
  if (fetchError) return { ok: false, status: 502, error: 'mint_failed' }
  const user = fetched.user
  // `disabled`/`disabled_at` ride on the auth.admin payloads but not on
  // the public User type — same read-with-cast pattern the admin login
  // route uses for email_confirmed_at.
  const flags = user as { disabled?: boolean; disabled_at?: string | null } | null
  if (!user || flags?.disabled || flags?.disabled_at || !user.email) {
    return { ok: false, status: 404, error: 'not_found' }
  }

  // Step 2: issue the magic-link token HASH without sending the email.
  const { data: link, error: linkError } = await client.auth.admin.generateLink({
    type: 'magiclink',
    email: user.email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (linkError || !tokenHash) {
    return { ok: false, status: 502, error: 'mint_failed' }
  }

  // Step 3: redeem the hash for a standard customer session.
  const { data: verified, error: verifyError } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  })
  const session = verified?.session
  if (verifyError || !session?.access_token || !session?.refresh_token) {
    return { ok: false, status: 502, error: 'mint_failed' }
  }

  return {
    ok: true,
    session: { access_token: session.access_token, refresh_token: session.refresh_token },
    customerEmail: user.email,
  }
}
