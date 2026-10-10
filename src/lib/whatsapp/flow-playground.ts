/**
 * Where a user goes to build a Flow by hand.
 *
 * Its own module because the URL has to be reachable from client
 * components (the Playground buttons, and their offline fallback) as well
 * as from the API route that answers "what should this link be?" — and a
 * second literal copy of a Meta URL is exactly how a stale link ships.
 */

/**
 * Meta's Flow Builder UI, inside WhatsApp Manager.
 *
 * Meta's own "Flows → Playground" documentation page is a static
 * configure-and-preview sample; the builder that produces a Flow you can
 * actually send — and where a Flow created through `POST /{waba_id}/flows`
 * shows up — is WhatsApp Manager. Deep-link to the Flows section
 * (`/wa/manage/flows/`), *not* the `/wa/manage/` overview, which dumps the
 * user on a landing page with no way to build. Meta documents scoping this
 * page to a specific account with `?waba_id=` (see a Flow Manager link in
 * their own developer-community answers), so `buildFlowsUrl` appends it.
 */
export const WHATSAPP_FLOWS_URL = 'https://business.facebook.com/wa/manage/flows/';

/**
 * The Flows page, scoped to a WABA when we know one.
 *
 * We can pass `waba_id` (the connection stores it) but not `business_id`
 * (the Business Manager portfolio id is never captured), so Meta may still
 * land on a portfolio picker. That's why a link built here is reported as
 * *not fully scoped* — the panel keeps naming the WABA to select.
 */
export function buildFlowsUrl(wabaId: string | null): string {
  if (!wabaId) return WHATSAPP_FLOWS_URL;
  return `${WHATSAPP_FLOWS_URL}?waba_id=${encodeURIComponent(wabaId)}`;
}

export interface PlaygroundLink {
  url: string;
  /** True only when the URL itself lands inside the right business. */
  scoped: boolean;
  /** The account's WABA id, so the panel can say what to select there. */
  wabaId: string | null;
}

/**
 * The link to fall back to when the API call itself fails: the Flows page,
 * unscoped. Same shape the endpoint returns, so the UI never has to model a
 * third state — and even before the WABA is known it opens Flows, not the
 * overview.
 */
export const GENERIC_PLAYGROUND_LINK: PlaygroundLink = {
  url: WHATSAPP_FLOWS_URL,
  scoped: false,
  wabaId: null,
};
