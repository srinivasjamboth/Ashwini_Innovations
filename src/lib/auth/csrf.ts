/**
 * Same-origin check for session-bound, state-changing billing POSTs
 * (spec PART 3.1 / PART 5 CSRF).
 *
 * Supabase's auth cookies are SameSite=Lax, which already stops a
 * cross-site form POST from CARRYING the session — so an attacker's
 * request would fail the role check anyway. This is the explicit,
 * defence-in-depth layer the payments spec asks for: a browser request
 * whose Origin/Referer is a different site is refused before we ever
 * create a gateway order.
 *
 * Requests with NO Origin/Referer (same-origin XHR in some browsers,
 * native clients, the reconciliation cron) are allowed — the auth role
 * check still gates them. Only a PRESENT origin/referer that disagrees
 * with the request host is rejected. This mirrors the middleware's own
 * dev-origin awareness without hard-failing legitimate server-to-server.
 *
 * NOTE: deliberately NOT applied to the Razorpay webhook or the redirect
 * `callback` route — those are cross-site by nature and are authenticated
 * by signature, not by session/origin.
 */

import { ForbiddenError } from './account';

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Throw `ForbiddenError` when the request carries a cross-site
 * Origin/Referer. Safe to call at the top of any session-bound billing
 * handler inside its existing try/catch (it maps to 403 via
 * `toErrorResponse`).
 */
export function assertSameOrigin(request: Request): void {
  const requestHost = hostOf(request.url);
  if (!requestHost) return; // unparseable — leave to the auth layer
  const originHost = hostOf(request.headers.get('origin'));
  const refererHost = hostOf(request.headers.get('referer'));
  for (const peer of [originHost, refererHost]) {
    if (peer && peer !== requestHost) {
      throw new ForbiddenError('Cross-origin request rejected');
    }
  }
}
