/**
 * The ONE place the Meta Billing Hub URL is built.
 *
 * Every "Billing & payments" affordance in the app (currently the
 * Settings → WhatsApp connected-state card) must go through
 * `buildMetaBillingUrl` — either directly on the client (the base-URL
 * fallback) or via GET /api/whatsapp/billing-link on the server (the
 * scoped URL). When Meta changes the URL shape, this file is the only
 * file that edits.
 *
 * URL PATTERN (2026-11 — observed from Meta's own UI and the owner's
 * Billing Hub screenshot; not a documented Meta contract, so re-check
 * it from a logged-in browser before "fixing" a supposed regression):
 * the page the customer needs is Meta Business Suite →
 * "Billing & payments" (Billing Hub) → Accounts → "Messaging accounts"
 * tab, listing each WhatsApp account with "How you'll pay", "Current
 * balance" and "Add payment method". Its home is
 *   https://business.facebook.com/billing_hub/accounts/
 * and Meta Business Suite URLs accept `?business_id={PORTFOLIO_ID}` to
 * scope them to one portfolio — the same companion parameter WhatsApp
 * Manager deep links use.
 * `asset_id` (the WABA id) is NOT appended: Billing Hub's Accounts
 * screen is portfolio-level and shows the messaging-account tab for
 * the whole portfolio; an unverified asset_id slot risks Meta either
 * ignoring it or landing on a different sub-view, and the account row
 * is visible either way. Meta documents no formal contract for these
 * parameters, so treat the pattern as observed behavior, not an API —
 * which is exactly why every billing link in the app is built here.
 *
 * Without a portfolio id the base URL still works: Meta opens the
 * billing of the portfolio the logged-in user last used. Never block
 * the page for a missing id — that is the whole point of the fallback.
 */

export const META_BILLING_BASE_URL =
  'https://business.facebook.com/billing_hub/accounts/';

export interface MetaBillingLinkParts {
  /** Meta business portfolio id — whatsapp_config.business_id. */
  businessId: string | null;
  /** Connected WABA id. Kept in the signature for future scoping;
   *  deliberately not part of the URL today (see header comment). */
  wabaId?: string | null;
}

/** Meta ids are digit strings; anything else must never reach a URL. */
function isMetaId(value: string | null | undefined): value is string {
  return !!value && /^[0-9]+$/.test(value);
}

/** The Billing Hub Accounts URL, scoped to the portfolio when known. */
export function buildMetaBillingUrl(parts: MetaBillingLinkParts): string {
  if (!isMetaId(parts.businessId)) return META_BILLING_BASE_URL;
  const url = new URL(META_BILLING_BASE_URL);
  url.searchParams.set('business_id', parts.businessId);
  return url.toString();
}
