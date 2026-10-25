/**
 * Plan engine — shared types.
 *
 * These describe the shape of the database rows (migration 048) as they
 * cross the service boundary. Nothing here hard-codes a plan value: the
 * numbers come from plan_limits / plan_features / plan_prices rows.
 */

import type { FeatureFlag, LimitFeature } from './config';

export type PlanKey = 'trial' | 'starter' | 'growth' | 'enterprise';

export type BillingCycle = 'monthly' | 'yearly';

/** Stored status, as written by the DB / billing service. */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'expired'
  | 'canceled'
  | 'past_due';

/** Status computed at request time from period end (+ GRACE_DAYS). This is
 *  what enforcement and the UI actually branch on — see Part 3. */
export type EffectiveStatus = 'trialing' | 'active' | 'expired';

/** A limit period: a stored-count cap, or a monthly reset window. */
export type LimitPeriod = 'total' | 'monthly';

/** The subscription row shape we read from PostgREST. */
export interface SubscriptionRow {
  account_id: string;
  user_id: string;
  plan_id: PlanKey;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  trial_claimed_at: string | null;
}

/** The whole answer to "what may this account do right now". */
export interface Entitlements {
  accountId: string;
  plan: PlanKey | null;
  planName: string | null;
  cycle: BillingCycle;
  /** Raw stored status. */
  status: SubscriptionStatus;
  /** Request-time status — branch on THIS, not `status`. */
  effectiveStatus: EffectiveStatus;
  periodStart: string | null;
  periodEnd: string | null;
  trialClaimedAt: string | null;
  /** feature -> numeric cap, -1 = unlimited. Missing feature -> unlimited. */
  limits: Partial<Record<LimitFeature, number>>;
  /** feature -> 'total' | 'monthly'. */
  limitPeriods: Partial<Record<LimitFeature, LimitPeriod>>;
  /** flag -> enabled. */
  features: Partial<Record<FeatureFlag, boolean>>;
  /** feature -> current usage. */
  usage: Partial<Record<LimitFeature, number>>;
}

/** The structured denial body from Part 3. Returned by the API as HTTP 403
 *  with `allowed: false`, and consumed by the shared upgrade/renew modal. */
export interface EnforcementResult {
  allowed: boolean;
  reason?:
    | 'subscription_expired'
    | 'limit_reached'
    | 'feature_not_included';
  feature: string;
  limit: number;
  current: number;
  remaining: number;
  upgrade_required: boolean;
}
