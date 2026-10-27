/**
 * Plan engine — public catalog reader.
 *
 * Part 5: "Render [the pricing cards] from the database ... changing a
 * number in the database changes all three [pricing page, enforcement,
 * billing tab]." This reads plans + plan_prices + plan_limits +
 * plan_features and shapes them for the pricing cards and the billing tab.
 *
 * Uses the service-role client: the catalog is world-readable (its RLS
 * allows anon SELECT) but reading via service-role avoids depending on an
 * anon session existing in a server component, and it's the same rows the
 * enforcement engine reads, so prices/limits shown == limits enforced.
 */

import { supabaseAdmin } from './admin-client';
import {
  FEATURE_FLAGS,
  LIMIT_FEATURES,
  yearlyBillingEnabled,
  type FeatureFlag,
  type LimitFeature,
} from './config';
import type { BillingCycle, LimitPeriod, PlanKey } from './types';

export interface PlanCard {
  id: PlanKey;
  name: string;
  tagline: string | null;
  isPaid: boolean;
  sort: number;
  /** Amount per cycle. Yearly is seeded monthly x 12 (flag 1). */
  prices: Record<BillingCycle, number>;
  currency: string;
  /** MONTHLY figures (plan_limits). Kept as the default view so every
   *  existing reader is unchanged; use `cardLimits()` to render a cycle. */
  limits: Partial<Record<LimitFeature, number>>;
  limitPeriods: Partial<Record<LimitFeature, LimitPeriod>>;
  /** STORED yearly figures (plan_yearly_limits, migration 052). Absent for
   *  a figure whose yearly row does not exist — callers fall back to the
   *  monthly value, exactly like enforcement does. Never derived at
   *  runtime: these are the rows the seed wrote from the multiplier map. */
  yearlyLimits: Partial<Record<LimitFeature, number>>;
  yearlyLimitPeriods: Partial<Record<LimitFeature, LimitPeriod>>;
  features: Partial<Record<FeatureFlag, boolean>>;
  /** Gateway plan ids per cycle. A cycle with no id cannot be checked out. */
  gatewayPlanIds: Partial<Record<BillingCycle, string | null>>;
  /** DISPLAY gate: this card has STORED yearly figures to show (flag on, a
   *  paid plan, and at least one `plan_yearly_limits` row). Yearly numbers go
   *  on the cards as soon as they are real data — before the gateway ids are
   *  minted — because the numbers a customer reads must be the numbers that
   *  exist in the database, never a re-derivation.
   *  This is deliberately NOT the purchase gate: that is `yearlyAvailable`. */
  yearlyShown: boolean;
  /** Purchase gate: the yearly option must be disabled for THIS plan when it
   *  is off (flag off, a free plan, no stored yearly figures, or no yearly
   *  price row). Controls the checkout CTA, not the figures. Note what is
   *  deliberately NOT in here: `gatewayPlanIds.yearly`. Monthly never required
   *  a stored gateway id (checkout mints it on first use), so demanding one
   *  for yearly alone disabled every card for a reason that had nothing to do
   *  with the customer's plan. See `computeYearlyAvailable`. */
  yearlyAvailable: boolean;
}

/** The figures to SHOW for a card on a cycle — the same overlay rule the
 *  enforcement engine uses (yearly row if stored, monthly row otherwise).
 *  The free trial has no yearly version, so it always reads monthly. */
export function cardLimits(plan: PlanCard, cycle: BillingCycle): Partial<Record<LimitFeature, number>> {
  if (cycle !== 'yearly' || !plan.yearlyShown) return plan.limits;
  return { ...plan.limits, ...plan.yearlyLimits };
}

export function cardLimitPeriods(plan: PlanCard, cycle: BillingCycle): Partial<Record<LimitFeature, LimitPeriod>> {
  if (cycle !== 'yearly' || !plan.yearlyShown) return plan.limitPeriods;
  return { ...plan.limitPeriods, ...plan.yearlyLimitPeriods };
}

/** Display gate — see `PlanCard.yearlyShown`. A plan with no stored yearly
 *  row at all keeps its monthly figures in Yearly view (the same per-figure
 *  fallback enforcement uses), so nothing is ever invented on a card. */
function computeYearlyShown(
  flagOn: boolean,
  isPaid: boolean,
  yearlyLimitsReadable: boolean,
  yearlyLimitCount: number,
): boolean {
  if (!flagOn) return false;
  if (!yearlyLimitsReadable) return false;
  // The free trial has no yearly version at all.
  if (!isPaid) return false;
  return yearlyLimitCount > 0;
}

/** Purchase gate: the figures must exist (so a yearly payer is never charged
 *  under a yearly label while enforcement applies monthly caps) AND the plan
 *  must carry a real yearly price row, or checkout would break.
 *
 *  A figure missing INSIDE an otherwise present table is intended and safe:
 *  that figure falls back to its monthly row (spec PART 5).
 *
 *  The gateway plan id is NOT a precondition. Razorpay's absence is a
 *  DEPLOYMENT state, not a per-plan one — with no keys configured monthly is
 *  equally unbuyable, and `/api/billing/checkout` already answers that click
 *  with 503 `gateway_not_configured` ("Online payment isn't set up yet").
 *  Baking the id into this gate made every yearly card look discontinued while
 *  its monthly twin worked, which is the opposite of "the same framework". */
function computeYearlyAvailable(
  isPaid: boolean,
  yearlyPrice: number,
  yearlyShown: boolean,
): boolean {
  if (!yearlyShown) return false;
  if (!isPaid) return false;
  return yearlyPrice > 0;
}

export async function getPlanCatalog(): Promise<PlanCard[]> {
  const admin = supabaseAdmin();
  const flagOn = yearlyBillingEnabled();

  const [{ data: planRows }, { data: priceRows }, { data: limitRows }, { data: featureRows }, yearlyRes] =
    await Promise.all([
      admin
        .from('plans')
        .select('id,name,tagline,is_paid,sort')
        .eq('is_public', true)
        .order('sort', { ascending: true }),
      admin.from('plan_prices').select('plan_id,billing_cycle,amount,currency,gateway_plan_id'),
      admin.from('plan_limits').select('plan_id,feature,value,period'),
      admin.from('plan_features').select('plan_id,feature,enabled'),
      // Read-only, world-readable table. If migration 052 has not been
      // applied yet the read fails and the catalog simply has no yearly
      // figures — every plan's yearly option then reads as unavailable
      // instead of showing monthly numbers under a "/year" label.
      admin.from('plan_yearly_limits').select('plan_id,feature,value,period'),
    ]);

  const byPlan = new Map<PlanKey, PlanCard>();
  for (const p of (planRows ?? []) as {
    id: PlanKey;
    name: string;
    tagline: string | null;
    is_paid: boolean;
    sort: number;
  }[]) {
    byPlan.set(p.id, {
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      isPaid: p.is_paid,
      sort: p.sort,
      prices: { monthly: 0, yearly: 0 },
      currency: 'INR',
      limits: {},
      limitPeriods: {},
      yearlyLimits: {},
      yearlyLimitPeriods: {},
      features: {},
      gatewayPlanIds: {},
      yearlyShown: false,
      yearlyAvailable: false,
    });
  }

  for (const r of (priceRows ?? []) as {
    plan_id: PlanKey;
    billing_cycle: BillingCycle;
    amount: number;
    currency: string;
    gateway_plan_id: string | null;
  }[]) {
    const card = byPlan.get(r.plan_id);
    if (!card) continue;
    card.prices[r.billing_cycle] = Number(r.amount);
    card.currency = r.currency;
    card.gatewayPlanIds[r.billing_cycle] = r.gateway_plan_id ?? null;
  }

  for (const r of (limitRows ?? []) as {
    plan_id: PlanKey;
    feature: LimitFeature;
    value: number;
    period: LimitPeriod;
  }[]) {
    const card = byPlan.get(r.plan_id);
    if (!card) continue;
    card.limits[r.feature] = Number(r.value);
    card.limitPeriods[r.feature] = r.period;
  }

  if (yearlyRes.error) {
    console.error('[plans/catalog] plan_yearly_limits not readable (apply migration 052):', yearlyRes.error.message);
  }
  const yearlyLimitsReadable = !yearlyRes.error;
  for (const r of ((yearlyRes.data ?? []) as {
    plan_id: PlanKey;
    feature: LimitFeature;
    value: number;
    period: LimitPeriod;
  }[])) {
    const card = byPlan.get(r.plan_id);
    if (!card) continue;
    card.yearlyLimits[r.feature] = Number(r.value);
    card.yearlyLimitPeriods[r.feature] = r.period;
  }

  for (const r of (featureRows ?? []) as {
    plan_id: PlanKey;
    feature: FeatureFlag;
    enabled: boolean;
  }[]) {
    const card = byPlan.get(r.plan_id);
    if (!card) continue;
    card.features[r.feature] = r.enabled;
  }

  // Stable, low→high sort order.
  const cards = [...byPlan.values()];
  for (const card of cards) {
    card.yearlyShown = computeYearlyShown(
      flagOn,
      card.isPaid,
      yearlyLimitsReadable,
      Object.keys(card.yearlyLimits).length,
    );
    card.yearlyAvailable = computeYearlyAvailable(
      card.isPaid,
      card.prices.yearly,
      card.yearlyShown,
    );
  }
  return cards.sort((a, b) => a.sort - b.sort);
}

/** Re-export the canonical feature lists so the billing tab and pricing
 *  page render the same keys the DB seeds, with no local copies. */
export { FEATURE_FLAGS, LIMIT_FEATURES };
