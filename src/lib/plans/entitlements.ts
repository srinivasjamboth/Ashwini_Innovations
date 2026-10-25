/**
 * Plan engine — entitlements service (the single shared check).
 *
 * Part 4: "Implement one entitlement function, for example
 * getEntitlements(accountId), returning plan, cycle, effective status,
 * period dates, limits, feature flags, and usage. Cache it briefly with
 * explicit invalidation. Every gated action must call the same check and
 * increment/decrement helpers."
 *
 * This module is the ONLY place plan/limit/expiry logic lives. The API
 * routes, the dashboard banner, the pricing page CTA states, the billing
 * tab and the cron all read from here (directly or via the DTO it returns)
 * so the three surfaces named in Part 1 — pricing page, enforcement,
 * billing tab — can never disagree.
 *
 * Reads use the service-role client: an enforcement answer must be
 * authoritative for the whole account regardless of which member (owner,
 * admin, or agent) triggers it, and RLS would otherwise hide the
 * subscription/usage rows from lower roles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './admin-client';
import {
  FEATURE_FLAGS,
  FAIR_USE_ALERT_THRESHOLD,
  GRACE_DAYS,
  LIMIT_FEATURES,
  LIMIT_SOURCE_TABLES,
  UNLIMITED,
  type FeatureFlag,
  type LimitFeature,
} from './config';
import { windowMonthKey } from './period';
import type {
  EffectiveStatus,
  Entitlements,
  EnforcementResult,
  LimitPeriod,
  SubscriptionRow,
} from './types';

/* ------------------------------------------------------------------ *
 * Effective status — Part 3 "ONE shared function for effective status
 * everywhere". Computed from the stored period end at request time, so a
 * subscription whose period end is in the past is expired immediately,
 * even before the cron flips the stored status.
 * ------------------------------------------------------------------ */
export function computeEffectiveStatus(
  sub: Pick<SubscriptionRow, 'status' | 'current_period_end' | 'trial_end'> | null,
  now: Date = new Date(),
  graceDays: number = GRACE_DAYS,
): EffectiveStatus {
  if (!sub) return 'expired';
  if (sub.status === 'canceled') return 'expired';
  const endRaw = sub.current_period_end ?? sub.trial_end;
  if (!endRaw) return sub.status === 'trialing' ? 'trialing' : 'active';
  const endMs = new Date(endRaw).getTime() + graceDays * 86_400_000;
  if (endMs <= now.getTime()) return 'expired';
  return sub.status === 'trialing' ? 'trialing' : 'active';
}

/* ------------------------------------------------------------------ *
 * Short-lived cache with explicit invalidation (Part 4).
 * Keyed by account. Bypassed whenever a caller injects `now` (clock is
 * only injected in tests / cron sweeps, so we never serve a stale,
 * time-shifted answer to a live request).
 * ------------------------------------------------------------------ */
const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: Entitlements }>();

export function invalidateEntitlements(accountId: string): void {
  cache.delete(accountId);
}

/** Test helper — clears the module cache so unit tests don't leak state. */
export function __resetPlanCacheForTests(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ *
 * Usage counting.
 *
 * `total` limits answer with a live COUNT against the owning table, so
 * deleting a resource frees a slot automatically (Part 4). `templates`
 * excludes Meta-rejected rows so a rejection never wastes a slot. Team is
 * profiles (incl. owner) + pending invitations. `bulk_messages` is the one
 * append-only counter in usage_counters.
 * ------------------------------------------------------------------ */
interface CountFilter {
  column: string;
  op: 'eq' | 'neq' | 'is' | 'gt';
  value: unknown;
}

async function headCount(
  admin: SupabaseClient,
  table: string,
  accountId: string,
  filters: CountFilter[] = [],
): Promise<number> {
  let q = admin.from(table).select('id', { count: 'exact', head: true }).eq('account_id', accountId);
  for (const f of filters) {
    if (f.op === 'neq') q = q.neq(f.column, f.value);
    else if (f.op === 'is') q = q.is(f.column, f.value);
    else if (f.op === 'gt') q = q.gt(f.column, f.value);
    else q = q.eq(f.column, f.value);
  }
  const { count, error } = await q;
  if (error) {
    // Fail open on an unexpected query error: a transient DB hiccup must
    // not lock a paying customer out of creating. Flagged in the report.
    console.error(`[plans] usage count failed for ${table}/${accountId}:`, error.message);
    return 0;
  }
  return count ?? 0;
}

async function countUsage(
  admin: SupabaseClient,
  feature: LimitFeature,
  accountId: string,
  period: LimitPeriod,
  windowAnchor: Date,
  now: Date,
): Promise<number> {
  switch (feature) {
    case 'templates':
      return headCount(admin, 'message_templates', accountId, [
        { column: 'status', op: 'neq', value: 'REJECTED' },
      ]);
    case 'team_members': {
      const members = await headCount(admin, 'profiles', accountId);
      const pending = await headCount(admin, 'account_invitations', accountId, [
        { column: 'accepted_at', op: 'is', value: null },
        { column: 'expires_at', op: 'gt', value: now.toISOString() },
      ]);
      return members + pending;
    }
    case 'bulk_messages': {
      // Monthly window for paid plans; lifetime (period_month IS NULL)
      // for the trial's "100 total" cap.
      const q = admin
        .from('usage_counters')
        .select('value')
        .eq('account_id', accountId)
        .eq('feature', 'bulk_messages');
      const { data, error } =
        period === 'monthly'
          ? await q.eq('period_month', windowMonthKey(windowAnchor, now))
          : await q.is('period_month', null);
      if (error || !data || data.length === 0) return 0;
      return Number(data[0].value ?? 0);
    }
    default: {
      const table = LIMIT_SOURCE_TABLES[feature];
      if (!table) return 0;
      return headCount(admin, table, accountId);
    }
  }
}

/* ------------------------------------------------------------------ *
 * getEntitlements — the whole answer for an account, cached briefly.
 * ------------------------------------------------------------------ */
export async function getEntitlements(
  accountId: string,
  opts?: { now?: Date; admin?: SupabaseClient },
): Promise<Entitlements> {
  const now = opts?.now;
  const useCache = now === undefined;
  if (useCache) {
    const hit = cache.get(accountId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  const admin = opts?.admin ?? supabaseAdmin();
  const clock = now ?? new Date();

  const { data: subRow, error: subErr } = await admin
    .from('subscriptions')
    .select(
      'account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at',
    )
    .eq('account_id', accountId)
    .maybeSingle();

  if (subErr) console.error('[plans] subscription read failed:', subErr.message);

  const sub = (subRow ?? null) as SubscriptionRow | null;
  const effectiveStatus = computeEffectiveStatus(sub, clock);

  // No subscription (shouldn't happen post-048 backfill) → treat as an
  // expired trial with zero caps. Enforcement will block creates but the
  // customer can still read everything and open Billing to subscribe.
  const planId = sub?.plan_id ?? null;

  const emptyEnt: Entitlements = {
    accountId,
    plan: planId,
    planName: null,
    cycle: sub?.billing_cycle ?? 'monthly',
    status: sub?.status ?? 'expired',
    effectiveStatus,
    periodStart: sub?.current_period_start ?? null,
    periodEnd: sub?.current_period_end ?? sub?.trial_end ?? null,
    trialClaimedAt: sub?.trial_claimed_at ?? null,
    limits: {},
    limitPeriods: {},
    features: {},
    usage: {},
  };

  if (!planId) {
    if (useCache) cache.set(accountId, { at: Date.now(), value: emptyEnt });
    return emptyEnt;
  }

  // Plan name + limits + features in parallel.
  const [{ data: planRow }, { data: limitRows }, { data: featureRows }] = await Promise.all([
    admin.from('plans').select('id,name').eq('id', planId).maybeSingle(),
    admin.from('plan_limits').select('feature,value,period').eq('plan_id', planId),
    admin.from('plan_features').select('feature,enabled').eq('plan_id', planId),
  ]);

  const limits: Entitlements['limits'] = {};
  const limitPeriods: Entitlements['limitPeriods'] = {};
  for (const r of (limitRows ?? []) as { feature: string; value: number; period: string }[]) {
    limits[r.feature as LimitFeature] = Number(r.value);
    limitPeriods[r.feature as LimitFeature] = r.period as LimitPeriod;
  }

  const features: Entitlements['features'] = {};
  for (const r of (featureRows ?? []) as { feature: string; enabled: boolean }[]) {
    features[r.feature as FeatureFlag] = r.enabled;
  }

  // Window anchor for monthly quotas = subscription period start.
  const windowAnchor = new Date(
    sub?.current_period_start ?? sub?.trial_end ?? clock.toISOString(),
  );

  // Usage counts in parallel. Only features that have a defined limit or
  // are bulk_messages need counting; skip counting for unlimited to save
  // a query (usage still reported as the live count for the billing tab,
  // so we do count them — but keep it cheap by awaiting together).
  const usageEntries = await Promise.all(
    LIMIT_FEATURES.map(async (feature) => {
      const period = limitPeriods[feature] ?? 'total';
      const value = await countUsage(admin, feature, accountId, period, windowAnchor, clock);
      return [feature, value] as const;
    }),
  );
  const usage: Entitlements['usage'] = {};
  for (const [f, v] of usageEntries) usage[f] = v;

  const result: Entitlements = {
    ...emptyEnt,
    planName: (planRow as { name?: string } | null)?.name ?? null,
    limits,
    limitPeriods,
    features,
    usage,
  };

  if (useCache) cache.set(accountId, { at: Date.now(), value: result });
  return result;
}

/* ------------------------------------------------------------------ *
 * The check helpers every gated action calls. They return the Part 3
 * structured result; API routes translate `allowed:false` into HTTP 403
 * with the exact body shape.
 * ------------------------------------------------------------------ */

function denial(
  reason: NonNullable<EnforcementResult['reason']>,
  feature: string,
  limit: number,
  current: number,
): EnforcementResult {
  return {
    allowed: false,
    reason,
    feature,
    limit,
    current,
    remaining: limit === UNLIMITED ? Infinity : Math.max(0, limit - current),
    upgrade_required: true,
  };
}

const ALLOWED_UNLIMITED = (feature: string): EnforcementResult => ({
  allowed: true,
  feature,
  limit: UNLIMITED,
  current: 0,
  remaining: Infinity,
  upgrade_required: false,
});

/**
 * Check a numeric (counted) limit before creating `quantity` rows or
 * sending `quantity` bulk messages. Pass `quantity = batch size` so a CSV
 * import / campaign send is rejected as a WHOLE operation when it exceeds
 * remaining capacity (Part 4 batch pre-check).
 */
export async function checkLimit(
  accountId: string,
  feature: LimitFeature,
  quantity = 1,
  opts?: { now?: Date; admin?: SupabaseClient },
): Promise<EnforcementResult> {
  const ent = await getEntitlements(accountId, opts);

  // Expired mode blocks gated creates + bulk sends (Part 3). Reading and
  // existing data are unaffected — callers only reach here on a write.
  if (ent.effectiveStatus === 'expired') {
    return denial('subscription_expired', feature, ent.limits[feature] ?? 0, ent.usage[feature] ?? 0);
  }

  const limit = ent.limits[feature];
  if (limit === undefined || limit === UNLIMITED) {
    // No row means not gated on this plan → allow (unlimited).
    const current = ent.usage[feature] ?? 0;
    return {
      allowed: true,
      feature,
      limit: UNLIMITED,
      current,
      remaining: Infinity,
      upgrade_required: false,
    };
  }

  const current = ent.usage[feature] ?? 0;
  if (current + quantity > limit) {
    return denial('limit_reached', feature, limit, current);
  }
  return {
    allowed: true,
    feature,
    limit,
    current,
    remaining: Math.max(0, limit - current),
    upgrade_required: false,
  };
}

/** Check a boolean feature flag (fields_tags, broadcast_scheduler, ai_agent). */
export async function checkFeature(
  accountId: string,
  feature: FeatureFlag,
  opts?: { now?: Date; admin?: SupabaseClient },
): Promise<EnforcementResult> {
  const ent = await getEntitlements(accountId, opts);
  if (ent.effectiveStatus === 'expired') {
    return denial('subscription_expired', feature, 0, 0);
  }
  // Presence of a defined flag that is false = blocked on this plan.
  // Unknown flag = not managed here → allow (common feature safety).
  const enabled = ent.features[feature];
  if (enabled === false) {
    return denial('feature_not_included', feature, 0, 0);
  }
  return ALLOWED_UNLIMITED(feature);
}

/* ------------------------------------------------------------------ *
 * Bulk-message usage counter — the only incrementing counter. Deletions
 * never restore it (Part 4). Enterprise is never blocked; we just record
 * whether the monthly total crossed FAIR_USE_ALERT_THRESHOLD so the
 * operator can review.
 * ------------------------------------------------------------------ */
export async function incrementUsage(
  accountId: string,
  feature: LimitFeature,
  by: number,
  opts?: { now?: Date; admin?: SupabaseClient },
): Promise<void> {
  if (by <= 0) return;
  const admin = opts?.admin ?? supabaseAdmin();
  const now = opts?.now ?? new Date();

  const ent = await getEntitlements(accountId, { now, admin });
  const period = ent.limitPeriods[feature] ?? 'total';

  // Resolve current values for the window we're about to write.
  const anchor = new Date(ent.periodStart ?? now.toISOString());
  const monthKey = period === 'monthly' ? windowMonthKey(anchor, now) : null;

  const { data: existing } = await admin
    .from('usage_counters')
    .select('id,value')
    .eq('account_id', accountId)
    .eq('feature', feature)
    .eq('period_month', monthKey as string)
    .maybeSingle();

  // For lifetime (period_month null) the eq above won't match; refetch.
  let row: { id: string; value: number } | null = existing ?? null;
  if (!row && monthKey === null) {
    const { data } = await admin
      .from('usage_counters')
      .select('id,value')
      .eq('account_id', accountId)
      .eq('feature', feature)
      .is('period_month', null)
      .maybeSingle();
    row = (data as { id: string; value: number } | null) ?? null;
  }

  const newValue = Number(row?.value ?? 0) + by;

  if (row?.id) {
    await admin
      .from('usage_counters')
      .update({ value: newValue, updated_at: now.toISOString() })
      .eq('id', row.id);
  } else {
    await admin.from('usage_counters').insert({
      account_id: accountId,
      feature,
      period_month: monthKey,
      value: newValue,
    });
  }

  if (
    ent.plan === 'enterprise' &&
    Number(row?.value ?? 0) < FAIR_USE_ALERT_THRESHOLD &&
    newValue >= FAIR_USE_ALERT_THRESHOLD
  ) {
    console.warn(
      `[plans][fair-use] account ${accountId} crossed ${FAIR_USE_ALERT_THRESHOLD} bulk messages in the current month (now ${newValue}).`,
    );
  }

  // Usage changed → drop the cached snapshot so the next read is fresh.
  invalidateEntitlements(accountId);
}

/* ------------------------------------------------------------------ *
 * Route-side convenience: throw a typed error the auth `toErrorResponse`
 * sibling can map, OR return the enforcement body directly. We expose the
 * result objects; routes decide how to render. A tiny assert helper keeps
 * call sites one-liners.
 * ------------------------------------------------------------------ */
export class EnforcementError extends Error {
  readonly status = 403 as const;
  readonly body: EnforcementResult;
  constructor(result: EnforcementResult) {
    super(result.reason ?? 'forbidden');
    this.name = 'EnforcementError';
    this.body = result;
  }
}

export async function assertLimit(
  accountId: string,
  feature: LimitFeature,
  quantity = 1,
  opts?: { now?: Date; admin?: SupabaseClient },
): Promise<EnforcementResult> {
  const r = await checkLimit(accountId, feature, quantity, opts);
  if (!r.allowed) throw new EnforcementError(r);
  return r;
}

export async function assertFeature(
  accountId: string,
  feature: FeatureFlag,
  opts?: { now?: Date; admin?: SupabaseClient },
): Promise<EnforcementResult> {
  const r = await checkFeature(accountId, feature, opts);
  if (!r.allowed) throw new EnforcementError(r);
  return r;
}

/** Map an EnforcementError to the exact Part 3 HTTP 403 body. */
export function enforcementResponse(err: EnforcementError): Response {
  return new Response(JSON.stringify(err.body), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Re-export flags for callers that want the canonical feature lists.
export { FEATURE_FLAGS, LIMIT_FEATURES };
