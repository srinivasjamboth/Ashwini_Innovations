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
import { invalidateEntitlements } from './entitlements';
import { advancePeriod } from './period';
import type { BillingCycle, PlanKey, SubscriptionRow } from './types';

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
      'account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at',
    )
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as SubscriptionRow | null) ?? null;
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
