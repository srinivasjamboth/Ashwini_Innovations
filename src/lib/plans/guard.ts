/**
 * Plan engine — route-side enforcement helpers.
 *
 * These keep each create/send API route to a couple of lines while making
 * sure every gated action funnels through the SAME getEntitlements check
 * (Part 4: "put checks in the shared service layer, never only in the UI or
 * one route"). Routes import the assert* helpers from entitlements directly;
 * this module adds the two thin glue pieces: rendering the structured 403
 * (Part 3), and an expiry-only guard for chat replies (which are blocked when
 * expired but never count against a limit).
 */

import { NextResponse } from 'next/server';
import { EnforcementError, getEntitlements } from './entitlements';

/**
 * If `err` is an EnforcementError, return the exact Part 3 403 body:
 *   { allowed:false, reason, feature, limit, current, remaining,
 *     upgrade_required:true }
 * Otherwise return null so the caller falls through to the app's normal
 * toErrorResponse(). Put this FIRST in a route's catch block.
 */
export function planErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof EnforcementError) {
    return NextResponse.json(err.body, { status: 403 });
  }
  return null;
}

/**
 * Reject a send/act only when the account's EFFECTIVE status is expired.
 * Used by chat replies (Part 3 flag 5): a reply is not a bulk message and
 * never counts a limit, but expired mode blocks sending. Reading, existing
 * data, and inbound storage are unaffected.
 */
export async function assertActive(accountId: string, feature = 'send'): Promise<void> {
  const ent = await getEntitlements(accountId);
  if (ent.effectiveStatus === 'expired') {
    throw new EnforcementError({
      allowed: false,
      reason: 'subscription_expired',
      feature,
      limit: 0,
      current: 0,
      remaining: 0,
      upgrade_required: true,
    });
  }
}
