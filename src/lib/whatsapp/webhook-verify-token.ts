import crypto from 'node:crypto'

/**
 * An operator-configured webhook verify token.
 *
 * The stored token (`whatsapp_config.verify_token`) is per-account,
 * encrypted at rest, and never returned by the config GET endpoint — so
 * the Settings form shows it masked and the only way to know it is to have
 * typed it yourself. That is the right design for a hosted multi-tenant
 * deployment, and it is still the primary path in the webhook handler.
 *
 * This env var is the escape hatch for self-hosting: one operator who
 * configures their own WABA can set the token once in the environment and
 * enter that same value in Meta → WhatsApp → Configuration, without
 * round-tripping every account's settings form.
 *
 * What it does NOT weaken: the verify token only gates the one-time
 * `hub.challenge` handshake that Meta performs when a callback URL is
 * saved. Inbound payloads are authenticated separately, by the
 * HMAC-SHA256 `X-Hub-Signature-256` header in `webhook-signature.ts`, and
 * message routing still resolves the tenant by `phone_number_id`. A leak
 * of this token therefore lets someone complete a verification challenge,
 * not inject messages.
 *
 * Contract: unset (or blank) means no env token — behaviour is exactly as
 * before. Comma-separated values are accepted, mirroring `META_APP_SECRET`,
 * so a deployment fronting several Meta Apps can list each app's token.
 */

/** Split the raw env value into candidate tokens; empties dropped. */
export function parseEnvVerifyTokens(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * True when `candidate` equals any configured env token.
 *
 * Both sides are hashed before the constant-time compare. That is not
 * decoration: `timingSafeEqual` throws when buffer lengths differ, so
 * comparing the raw strings would either leak "these two tokens are not
 * even the same length" through an early return, or need a length check
 * that leaks it anyway. Fixed-length digests remove the problem, and the
 * loop never returns early.
 */
export function matchesEnvVerifyToken(candidate: string): boolean {
  const tokens = parseEnvVerifyTokens(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
  if (tokens.length === 0) return false

  const provided = crypto.createHash('sha256').update(candidate).digest()
  let ok = false
  for (const token of tokens) {
    const expected = crypto.createHash('sha256').update(token).digest()
    if (crypto.timingSafeEqual(provided, expected)) ok = true
  }
  return ok
}
