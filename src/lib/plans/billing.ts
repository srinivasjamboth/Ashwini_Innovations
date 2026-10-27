/**
 * Plan engine — subscription lifecycle (Part 2).
 *
 * Gateway-agnostic on purpose: the Razorpay wiring is deferred, but every
 * transition a payment gateway would trigger lives here and is directly
 * testable — activate/renew/upgrade/cancel/expiry all take an explicit
 * `referenceTime` (the clock the caller injects), so the whole billing
 * state machine is exercised without a live gateway.
 *
 * Idempotency (Part 2): a repeated webhook carrying the same gateway
 * payment reference can never extend a period twice — we short-circuit on
 * an existing paid transaction with that reference before mutating.
 */

import { supabaseAdmin } from './admin-client';
import { invalidateEntitlements, computeEffectiveStatus } from './entitlements';
import { advancePeriod } from './period';
import type { BillingCycle, EffectiveStatus, PlanKey, SubscriptionRow } from './types';

export interface ActivateArgs {
  accountId: string;
  planId: PlanKey;
  cycle: BillingCycle;
  /** Payment time. Defaults to now; tests/cron pass an explicit clock. */
  referenceTime?: Date;
  /** Unique gateway payment reference — the idempotency key. */
  gatewayPaymentId?: string | null;
  gatewayOrderId?: string | null;
  gatewaySubscriptionId?: string | null;
  gatewayCustomerId?: string | null;
  gateway?: string | null;
  amount?: number | null;
  currency?: string | null;
  /** When true, a duplicate gatewayPaymentId is treated as a no-op
   *  (idempotent) rather than an error. Webhooks set this. */
  idempotent?: boolean;
}

export interface ActivateResult {
  subscription: SubscriptionRow;
  /** False when a duplicate gateway reference short-circuited the write. */
  applied: boolean;
}

async function loadSubscription(
  accountId: string,
): Promise<SubscriptionRow | null> {
  const { data } = await supabaseAdmin()
    .from('subscriptions')
    .select(
      'account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at,gateway_subscription_id',
    )
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as SubscriptionRow | null) ?? null;
}

/* ------------------------------------------------------------------ *
 * Offering changes (spec PART 4).
 *
 * An upgrade, or monthly -> yearly, may be bought immediately. A paid
 * YEARLY period may not be downgraded — to a cheaper plan or back to
 * monthly — until it expires, because there is no proration and a
 * customer must never be able to trade away a year they already paid
 * for. Pure function so it is unit-testable and usable from both the
 * checkout route (before charging) and the gateway webhook (authority).
 * ------------------------------------------------------------------ */
export interface OfferingChangeVerdict {
  allowed: boolean;
  /** Set when a paid yearly period blocks the change: its period end. */
  blockedUntil?: string | null;
}

export function evaluateOfferingChange(input: {
  /** The account's CURRENT subscription row, or null (never subscribed). */
  current: Pick<SubscriptionRow, 'plan_id' | 'billing_cycle' | 'status' | 'current_period_end' | 'trial_end'> | null;
  /** Effective status at request time (expired periods never block). */
  effectiveStatus: EffectiveStatus;
  /** plans.sort — lower is cheaper. */
  currentSort: number;
  targetSort: number;
  targetCycle: BillingCycle;
}): OfferingChangeVerdict {
  const { current, effectiveStatus, currentSort, targetSort, targetCycle } = input;
  // Nothing to protect yet (no subscription, trial, or already expired).
  if (!current) return { allowed: true, blockedUntil: null };
  if (effectiveStatus === 'expired') return { allowed: true, blockedUntil: null };
  if (current.billing_cycle !== 'yearly') return { allowed: true, blockedUntil: null };
  if (current.plan_id === 'trial') return { allowed: true, blockedUntil: null };

  const isDowngrade = targetSort < currentSort;
  const toMonthly = targetCycle !== 'yearly';
  if (isDowngrade || toMonthly) {
    return {
      allowed: false,
      blockedUntil: current.current_period_end ?? current.trial_end ?? null,
    };
  }
  return { allowed: true, blockedUntil: null };
}

async function ownerIdFor(accountId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  return (data as { owner_user_id?: string } | null)?.owner_user_id ?? null;
}

/**
 * Apply a successful payment: set the plan, cycle and status, and compute
 * the new period end.
 *
 *   - On-time renewal (same plan + cycle, prior period still running):
 *     extend from the PREVIOUS period end so no days are lost.
 *   - Plan change / upgrade / downgrade: a NEW period starting at the
 *     payment time (no proration, Part 2).
 *   - Late payment (prior period already ended): fresh period from the
 *     payment time.
 */
export async function activateSubscription(args: ActivateArgs): Promise<ActivateResult> {
  const {
    accountId,
    planId,
    cycle,
    gatewayPaymentId = null,
    gatewayOrderId = null,
    gatewaySubscriptionId = null,
    gatewayCustomerId = null,
    gateway = null,
    amount = null,
    currency = 'INR',
    idempotent = true,
  } = args;

  const admin = supabaseAdmin();
  const referenceTime = args.referenceTime ?? new Date();
  const refIso = referenceTime.toISOString();

  // Idempotency guard: a paid transaction with this gateway reference has
  // already been applied → never extend twice.
  if (gatewayPaymentId && idempotent) {
    const { data: dup } = await admin
      .from('payment_transactions')
      .select('id')
      .eq('gateway_payment_id', gatewayPaymentId)
      .eq('status', 'paid')
      .maybeSingle();
    if (dup) {
      const existing = await loadSubscription(accountId);
      if (existing) return { subscription: existing, applied: false };
    }
  }

  const prev = await loadSubscription(accountId);
  const userId = prev?.user_id ?? (await ownerIdFor(accountId)) ?? '';

  const prevEndMs = prev?.current_period_end ? new Date(prev.current_period_end).getTime() : 0;
  const isSameOffering = prev && prev.plan_id === planId && prev.billing_cycle === cycle;
  const isOnTime = prevEndMs > referenceTime.getTime();

  let periodStartIso: string;
  let periodEndIso: string;
  if (isSameOffering && isOnTime) {
    // Renewal — keep the anchor, extend from previous period end.
    periodStartIso = prev!.current_period_start ?? refIso;
    periodEndIso = advancePeriod(new Date(prev!.current_period_end!), cycle).toISOString();
  } else {
    // New period (first payment, plan change, or late payment).
    periodStartIso = refIso;
    periodEndIso = advancePeriod(referenceTime, cycle).toISOString();
  }

  const payload = {
    account_id: accountId,
    user_id: userId,
    plan_id: planId,
    status: 'active' as const,
    billing_cycle: cycle,
    current_period_start: periodStartIso,
    current_period_end: periodEndIso,
    // Paid now — trial is over; keep trial_claimed_at so the pricing page
    // still knows the trial was used.
    trial_end: null,
    gateway: gateway ?? 'manual',
    ...(gatewaySubscriptionId ? { gateway_subscription_id: gatewaySubscriptionId } : {}),
    ...(gatewayCustomerId ? { gateway_customer_id: gatewayCustomerId } : {}),
    updated_at: refIso,
  };

  let subscription: SubscriptionRow;
  if (prev) {
    const { data, error } = await admin
      .from('subscriptions')
      .update(payload)
      .eq('account_id', accountId)
      .select(
        'account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at',
      )
      .single();
    if (error) throw new Error(`activate: subscription update failed: ${error.message}`);
    subscription = data as SubscriptionRow;
  } else {
    const { data, error } = await admin
      .from('subscriptions')
      .insert(payload)
      .select(
        'account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at',
      )
      .single();
    if (error) throw new Error(`activate: subscription insert failed: ${error.message}`);
    subscription = data as SubscriptionRow;
  }

  // Record the payment (unique gateway_payment_id enforces idempotency at
  // the DB level too — a racing duplicate insert throws, which we swallow
  // because the first writer already extended the period).
  try {
    await admin.from('payment_transactions').insert({
      account_id: accountId,
      plan_id: planId,
      billing_cycle: cycle,
      gateway: gateway ?? 'manual',
      gateway_order_id: gatewayOrderId,
      gateway_payment_id: gatewayPaymentId,
      amount,
      currency,
      status: 'paid',
      created_at: refIso,
    });
  } catch (insertErr) {
    const msg = (insertErr as Error).message ?? '';
    if (!msg.includes('duplicate key') && !msg.includes('unique')) {
      console.error('[plans] payment_transactions insert failed:', msg);
    }
  }

  invalidateEntitlements(accountId);
  return { subscription, applied: true };
}

/* ------------------------------------------------------------------ *
 * Route-facing guard: may this account buy `targetPlanId` / `targetCycle`
 * right now, given what it is already paying for?
 * ------------------------------------------------------------------ */
export async function evaluatePurchaseChange(
  accountId: string,
  targetPlanId: PlanKey,
  targetCycle: BillingCycle,
  now: Date = new Date(),
): Promise<OfferingChangeVerdict & { from?: PlanKey; fromCycle?: BillingCycle }> {
  const admin = supabaseAdmin();
  const prev = await loadSubscription(accountId);
  if (!prev) return { allowed: true, blockedUntil: null };

  const { data: planRows } = await admin.from('plans').select('id,sort');
  const sortOf = (id: string | null | undefined): number =>
    ((planRows ?? []) as { id: string; sort: number }[]).find((p) => p.id === id)?.sort ?? 0;

  const verdict = evaluateOfferingChange({
    current: prev,
    effectiveStatus: computeEffectiveStatus(prev, now),
    currentSort: sortOf(prev.plan_id),
    targetSort: sortOf(targetPlanId),
    targetCycle,
  });
  return { ...verdict, from: prev.plan_id, fromCycle: prev.billing_cycle };
}

/* ------------------------------------------------------------------ *
 * Double-billing guard (spec PART 4).
 *
 * A new gateway subscription starts the moment its first payment is
 * verified, so the customer's PREVIOUS one must be cancelled — otherwise
 * Razorpay keeps charging the old plan on its own schedule and they pay
 * for two plans at once. Called from the webhook after activate().
 *
 * Idempotent by construction:
 *   - no previous id, or the same id as the new subscription -> skipped
 *     (a renewal of the same offering must never cancel itself),
 *   - the gateway's "already cancelled / not able to cancel" responses are
 *     treated as success, so a replayed webhook is a no-op,
 *   - the stored column is cleared only after a confirmed cancellation,
 *     and a gateway failure NEVER blocks the activation the customer paid
 *     for — it is logged for the operator instead.
 * `cancel` is injected so this is unit-testable without a network.
 *
 * IMPORTANT: `previousGatewaySubscriptionId` must be captured BEFORE the
 * new payment is applied (activate overwrites the column), which is why the
 * caller passes it in instead of us reading it back afterwards.
 * ------------------------------------------------------------------ */
export async function loadGatewaySubscriptionId(accountId: string): Promise<string | null> {
  const prev = await loadSubscription(accountId);
  return prev?.gateway_subscription_id ?? null;
}

export async function settlePreviousGatewaySubscription(args: {
  accountId: string;
  /** The id the customer held BEFORE this activation (captured first). */
  previousGatewaySubscriptionId?: string | null;
  /** The subscription id the customer now holds. */
  keepGatewaySubscriptionId: string | null | undefined;
  cancel: (gatewaySubscriptionId: string) => Promise<{ cancelled: boolean; alreadyInactive?: boolean; error?: string }>;
}): Promise<{ attempted: boolean; cancelled: boolean; skippedReason?: string; error?: string }> {
  const { accountId, keepGatewaySubscriptionId, cancel } = args;
  const admin = supabaseAdmin();
  const previous =
    args.previousGatewaySubscriptionId !== undefined
      ? args.previousGatewaySubscriptionId
      : await loadGatewaySubscriptionId(accountId);

  if (!previous) return { attempted: false, cancelled: false, skippedReason: 'no_previous' };
  if (keepGatewaySubscriptionId && previous === keepGatewaySubscriptionId) {
    return { attempted: false, cancelled: false, skippedReason: 'same_subscription' };
  }

  const result = await cancel(previous);
  if (result.cancelled || result.alreadyInactive) {
    // Only drop the reference once the gateway says it is stopped; if the
    // call failed we keep it so an operator (or a retry) can still see what
    // needs cancelling.
    const { error: clearErr } = await admin
      .from('subscriptions')
      .update({ gateway_subscription_id: null, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('gateway_subscription_id', previous);
    if (clearErr) console.error('[plans] could not clear cancelled gateway subscription id:', clearErr.message);
    return { attempted: true, cancelled: true };
  }

  console.error(
    `[plans] DOUBLE-BILLING RISK: account ${accountId} still has gateway subscription ${previous} active (new one: ${keepGatewaySubscriptionId ?? 'none'}): ${result.error ?? 'cancel failed'}. Operator must cancel it manually.`,
  );
  return { attempted: true, cancelled: false, error: result.error };
}

/* ------------------------------------------------------------------ *
 * Resolve what a gateway plan id stands for.
 *
 * The webhook normally gets {account_id, plan_id, billing_cycle} in the
 * subscription NOTES we wrote at checkout. Notes are gateway-side data and
 * can be edited or dropped, so a `plan_prices.gateway_plan_id` lookup is
 * used to confirm/replace the plan + cycle — the DB stays the authority on
 * what is being sold, the gateway only says who paid.
 * ------------------------------------------------------------------ */
export async function resolveOfferingByGatewayPlan(
  gatewayPlanId: string | null | undefined,
): Promise<{ planId: PlanKey; cycle: BillingCycle } | null> {
  if (!gatewayPlanId) return null;
  const { data } = await supabaseAdmin()
    .from('plan_prices')
    .select('plan_id,billing_cycle')
    .eq('gateway_plan_id', gatewayPlanId)
    .maybeSingle();
  const row = data as { plan_id: PlanKey; billing_cycle: BillingCycle } | null;
  return row ? { planId: row.plan_id, cycle: row.billing_cycle } : null;
}

/** Cancel at period end (stored status flips to canceled; effective status
 *  becomes expired immediately only once the period end passes). */
export async function cancelSubscription(accountId: string, immediate = false): Promise<void> {
  const admin = supabaseAdmin();
  const prev = await loadSubscription(accountId);
  if (!prev) return;
  const nowIso = new Date().toISOString();
  if (immediate) {
    await admin
      .from('subscriptions')
      .update({ status: 'canceled', current_period_end: nowIso, updated_at: nowIso })
      .eq('account_id', accountId);
  } else {
    await admin
      .from('subscriptions')
      .update({ status: 'canceled', updated_at: nowIso })
      .eq('account_id', accountId);
  }
  invalidateEntitlements(accountId);
}

/**
 * Cron sweep (Part 3): flip the STORED status of any trialing/active
 * subscription whose period/trial end is now in the past to 'expired',
 * for tidiness. Enforcement never depends on this — effective status is
 * computed at request time — but keeping the column honest makes the admin
 * dashboard and reports read correctly. Returns the number flipped.
 */
export async function expireOverdueSubscriptions(now: Date = new Date()): Promise<number> {
  const admin = supabaseAdmin();
  const nowIso = now.toISOString();
  const { data, error } = await admin
    .from('subscriptions')
    .select('account_id,current_period_end,trial_end')
    .in('status', ['trialing', 'active', 'past_due']);
  if (error || !data) return 0;

  let flipped = 0;
  for (const row of data as Pick<SubscriptionRow, 'account_id' | 'current_period_end' | 'trial_end'>[]) {
    const endRaw = row.current_period_end ?? row.trial_end;
    if (!endRaw) continue;
    if (new Date(endRaw).getTime() <= now.getTime()) {
      const { error: updErr } = await admin
        .from('subscriptions')
        .update({ status: 'expired', updated_at: nowIso })
        .eq('account_id', row.account_id);
      if (!updErr) {
        flipped += 1;
        invalidateEntitlements(row.account_id);
      }
    }
  }
  return flipped;
}
