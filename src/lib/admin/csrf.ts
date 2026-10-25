/**
 * Minimal same-origin CSRF check for the admin login/logout POSTs.
 *
 * The Supabase session cookie is SameSite=Lax, which already blocks
 * cross-site form posts — this is the second half of the pair: a
 * same-site fetch fired from a script embedded on a malicious page
 * (possible if the page shares our registrable domain) would pass
 * SameSite but still carries a foreign `Origin`/`Sec-Fetch-Site`.
 *
 * Rule: if the browser sent an Origin, it must match Host exactly.
 * Non-browser clients (curl, tests) send neither header and are let
 * through — they have no ambient credentials to abuse anyway.
 */
export function sameOriginOrMissing(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return false
    } catch {
      return false
    }
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return false
  }
  return true
}
