/**
 * Admin login audit trail — writes to the insert-only
 * `admin_login_events` table (see migration 045).
 *
 * Rules enforced here:
 *   - One row per attempt, success or failure, before the route has
 *     answered the browser.
 *   - Never a password or token — only the attempted email, ip, UA.
 *   - INSERT/SELECT only; the table itself has no UPDATE/DELETE path
 *     reachable by any app role (RLS with zero policies + revoked
 *     grants for anon/authenticated, and this module is the sole
 *     writer with the service-role key).
 *   - Best-effort: an audit failure must never break (or leak detail
 *     into) the login response — we log server-side and move on.
 */

import { supabaseAdmin } from './supabase-admin'

const MAX_EMAIL_LEN = 320
const MAX_UA_LEN = 512

/** Best-effort client IP: proxy headers first, in the order the
 *  common deploy shapes (CDN → LB → node) write them. */
export function clientIpFrom(headers: Headers): string | null {
  const fwd = headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim() || null
  return headers.get('x-real-ip') ?? null
}

export async function recordLoginAttempt(opts: {
  attemptedEmail: string
  success: boolean
  headers: Headers
}): Promise<void> {
  try {
    await supabaseAdmin().from('admin_login_events').insert({
      attempted_email: opts.attemptedEmail.slice(0, MAX_EMAIL_LEN),
      success: opts.success,
      ip_address: clientIpFrom(opts.headers),
      user_agent: opts.headers.get('user-agent')?.slice(0, MAX_UA_LEN) ?? null,
    })
  } catch (err) {
    console.error('[admin-audit] failed to record login attempt:', err)
  }
}

/** Timestamp of the last SUCCESSFUL admin login (ISO string), or null.
 *  Powers the "Last login" indicator on Pulse. */
export async function getLastSuccessfulLogin(): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('admin_login_events')
      .select('created_at')
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error || !data?.length) return null
    return data[0].created_at as string
  } catch (err) {
    console.error('[admin-audit] last-login read failed:', err)
    return null
  }
}
