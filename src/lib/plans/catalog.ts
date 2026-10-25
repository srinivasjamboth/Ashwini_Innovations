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
  type FeatureFlag,
  type LimitFeature,
} from './config';
import type { BillingCycle, PlanKey } from './types';

export interface PlanCard {
  id: PlanKey;
  name: string;
  tagline: string | null;
  isPaid: boolean;
  sort: number;
  /** Amount per cycle. Yearly is seeded monthly x 12 (flag 1). */
  prices: Record<BillingCycle, number>;
  currency: string;
  limits: Partial<Record<LimitFeature, number>>;
  limitPeriods: Partial<Record<LimitFeature, 'total' | 'monthly'>>;
  features: Partial<Record<FeatureFlag, boolean>>;
  /** Gateway plan ids per cycle, filled once Razorpay is wired. */
  gatewayPlanIds: Partial<Record<BillingCycle, string | null>>;
}

export async function getPlanCatalog(): Promise<PlanCard[]> {
  const admin = supabaseAdmin();

  const [{ data: planRows }, { data: priceRows }, { data: limitRows }, { data: featureRows }] =
    await Promise.all([
      admin
        .from('plans')
        .select('id,name,tagline,is_paid,sort')
        .eq('is_public', true)
        .order('sort', { ascending: true }),
      admin.from('plan_prices').select('plan_id,billing_cycle,amount,currency,gateway_plan_id'),
      admin.from('plan_limits').select('plan_id,feature,value,period'),
      admin.from('plan_features').select('plan_id,feature,enabled'),
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
      features: {},
      gatewayPlanIds: {},
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
    period: 'total' | 'monthly';
  }[]) {
    const card = byPlan.get(r.plan_id);
    if (!card) continue;
    card.limits[r.feature] = Number(r.value);
    card.limitPeriods[r.feature] = r.period;
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
  return [...byPlan.values()].sort((a, b) => a.sort - b.sort);
}

/** Re-export the canonical feature lists so the billing tab and pricing
 *  page render the same keys the DB seeds, with no local copies. */
export { FEATURE_FLAGS, LIMIT_FEATURES };
