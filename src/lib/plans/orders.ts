/**
 * Plan engine — Razorpay ORDERS repository + the ONE idempotent
 * fulfilment (spec PART 3.4).
 *
 * Everything that touches `payment_orders` lives here so the four callers
 * — browser `verify`, the public `order.paid` webhook, the redirect
 * `callback`, and the reconciliation job — share one activation path and
 * can never diverge. Activation itself is delegated to the existing
 * `activateSubscription` (which already owns period maths, the payment
 * row, entitlement invalidation and DB-level idempotency on the unique
 * gateway payment reference). This module adds only the order-row state
 * machine on top.
 *
 * Idempotency is two-layered and deliberate:
 *   1. `fulfillPaidOrder` flips the order to `paid` with a conditional
 *      UPDATE (`status <> 'paid'`). A second delivery changes zero rows
 *      and short-circuits — the period is extended at most once per order.
 *   2. `activateSubscription` short-circuits on an existing paid
 *      `payment_transactions` row for the same gateway payment id, so even
 *      two DIFFERENT orders carrying the same payment cannot double-extend.
 *
 * RUPEES everywhere. A razorpay amount (paise) is converted to rupees at
 * the boundary before it reaches `activateSubscription`, which stores
 * rupees exactly like the rest of the engine.
 */

import { supabaseAdmin } from './admin-client';
import { activateSubscription, loadGatewaySubscriptionId, settlePreviousGatewaySubscription } from './billing';
import type { BillingCycle, PlanKey, SubscriptionRow } from './types';

export type OrderStatus = 'created' | 'attempted' | 'paid' | 'failed' | 'cancelled';
export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'wallet';

const ORDER_METHODS = new Set<string>(['upi', 'card', 'netbanking', 'wallet']);

export interface PaymentOrderRow {
  id: string;
  account_id: string;
  user_id: string | null;
  plan_id: PlanKey | null;
  plan_name_snapshot: string | null;
  billing_cycle: BillingCycle;
  amount: number;
  currency: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  receipt: string | null;
  status: OrderStatus;
  payment_method: PaymentMethod | null;
  failure_reason: string | null;
  fulfilled_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT =
  'id,account_id,user_id,plan_id,plan_name_snapshot,billing_cycle,amount,currency,' +
  'razorpay_order_id,razorpay_payment_id,receipt,status,payment_method,failure_reason,' +
  'fulfilled_at,created_at,updated_at';

/** Normalise the gateway's payment method to our CHECK constraint, or null. */
export function normalizePaymentMethod(raw: string | null | undefined): PaymentMethod | null {
  const m = (raw ?? '').trim().toLowerCase();
  return ORDER_METHODS.has(m) ? (m as PaymentMethod) : null;
}

/** Razorpay paise → rupees (2dp). The only place an order amount leaves
 *  the smallest unit; the DB and the engine only ever speak rupees. */
export function paiseToRupees(paise: number | null | undefined): number | null {
  if (typeof paise !== 'number' || !Number.isFinite(paise)) return null;
  return Math.round(paise) / 100;
}

/* ------------------------------------------------------------------ *
 * Insert / lookup
 * ------------------------------------------------------------------ */
export async function createPaymentOrder(args: {
  accountId: string;
  userId: string;
  planId: PlanKey;
  planName: string;
  cycle: BillingCycle;
  amountRupees: number;
  currency: string;
  razorpayOrderId: string;
  receipt: string;
}): Promise<PaymentOrderRow> {
  const { data, error } = await supabaseAdmin()
    .from('payment_orders')
    .insert({
      account_id: args.accountId,
      user_id: args.userId,
      plan_id: args.planId,
      plan_name_snapshot: args.planName,
      billing_cycle: args.cycle,
      amount: args.amountRupees,
      currency: args.currency,
      razorpay_order_id: args.razorpayOrderId,
      receipt: args.receipt,
      status: 'created',
    })
    .select(SELECT)
    .single();
  if (error) throw new Error(`createPaymentOrder failed: ${error.message}`);
  return data as unknown as PaymentOrderRow;
}

export async function loadOrderById(id: string): Promise<PaymentOrderRow | null> {
  const { data } = await supabaseAdmin()
    .from('payment_orders')
    .select(SELECT)
    .eq('id', id)
    .maybeSingle();
  return (data as PaymentOrderRow | null) ?? null;
}

export async function loadOrderByRazorpayId(razorpayOrderId: string): Promise<PaymentOrderRow | null> {
  if (!razorpayOrderId) return null;
  const { data } = await supabaseAdmin()
    .from('payment_orders')
    .select(SELECT)
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();
  return (data as PaymentOrderRow | null) ?? null;
}

/**
 * A still-open order for the SAME plan + cycle inside `withinMs`, so a
 * double click (or a retry after a closed sheet) reuses one Razorpay
 * order instead of stacking charges. `created`/`attempted` only; a paid
 * or failed order is never reused.
 */
export async function findReusableOrder(
  accountId: string,
  planId: PlanKey,
  cycle: BillingCycle,
  withinMs = 10 * 60 * 1000,
): Promise<PaymentOrderRow | null> {
  const since = new Date(Date.now() - withinMs).toISOString();
  const { data } = await supabaseAdmin()
    .from('payment_orders')
    .select(SELECT)
    .eq('account_id', accountId)
    .eq('plan_id', planId)
    .eq('billing_cycle', cycle)
    .in('status', ['created', 'attempted'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as PaymentOrderRow | null) ?? null;
}

/* ------------------------------------------------------------------ *
 * Status transitions (narrow, guarded)
 * ------------------------------------------------------------------ */

/** Mark a created order as attempted once the sheet is known to be in use. */
export async function markOrderAttempted(orderId: string): Promise<void> {
  await supabaseAdmin()
    .from('payment_orders')
    .update({ status: 'attempted', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'created');
}

/** Record a failed payment (reason + method). Never touches the plan. */
export async function markOrderFailed(
  orderId: string,
  info: { paymentId?: string | null; method?: PaymentMethod | null; reason?: string | null },
): Promise<void> {
  const payload: Record<string, unknown> = {
    status: 'failed',
    failure_reason: (info.reason ?? 'payment failed').slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  if (info.method) payload.payment_method = info.method;
  if (info.paymentId) payload.razorpay_payment_id = info.paymentId;
  await supabaseAdmin().from('payment_orders').update(payload).eq('id', orderId).neq('status', 'paid');
}

/* ------------------------------------------------------------------ *
 * The ONE idempotent activation (spec PART 3.4).
 * ------------------------------------------------------------------ */
export interface FulfillInput {
  /** The stored order row (authoritative: plan, cycle, amount, account). */
  order: PaymentOrderRow;
  /** The gateway payment id, once known (from verify, webhook or capture). */
  paymentId: string;
  /** Payment method (upi/card/…) for history. Optional. */
  method?: PaymentMethod | null;
  /** The gateway-confirmed amount in RUPEES. Optional; defaults to the
   *  stored order amount. Callers assert it equals the order before
   *  invoking; passed through to the payment record. */
  amountRupees?: number | null;
  currency?: string | null;
  /** Payment time — the clock the period is computed from. */
  referenceTime?: Date;
  /** Legacy gateway subscription to cancel, if the account still has one. */
  cancel?: (gatewaySubscriptionId: string) => Promise<{ cancelled: boolean; alreadyInactive?: boolean; error?: string }>;
}

export interface FulfillResult {
  /** True when THIS call was the one that activated/extended the plan. */
  applied: boolean;
  subscription: SubscriptionRow | null;
  order: PaymentOrderRow;
  periodEnd: string | null;
}

/**
 * Activate a paid order EXACTLY ONCE. Safe to call from verify, the
 * webhook, the callback and the reconciliation job, in any order and any
 * number of times: the conditional order flip makes a repeat a no-op, and
 * `activateSubscription` guards the payment reference at the DB level.
 */
export async function fulfillPaidOrder(input: FulfillInput): Promise<FulfillResult> {
  const { order, paymentId } = input;
  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();

  // Layer 1 — flip the order to paid ONLY if it is not already paid. If
  // zero rows change, another caller already fulfilled this exact order.
  const flip: Record<string, unknown> = {
    status: 'paid',
    razorpay_payment_id: paymentId,
    fulfilled_at: nowIso,
    updated_at: nowIso,
    failure_reason: null,
  };
  if (input.method) flip.payment_method = input.method;

  const { data: won, error: flipErr } = await admin
    .from('payment_orders')
    .update(flip)
    .eq('id', order.id)
    .neq('status', 'paid')
    .select(SELECT);

  if (flipErr) throw new Error(`fulfill: order flip failed: ${flipErr.message}`);

  const rows = (won ?? []) as unknown as PaymentOrderRow[];
  if (rows.length === 0) {
    // Already paid — return the current state, change nothing else.
    const current = await loadOrderById(order.id);
    const sub = await readSubscription(order.account_id);
    return {
      applied: false,
      subscription: sub,
      order: current ?? order,
      periodEnd: sub?.current_period_end ?? sub?.trial_end ?? null,
    };
  }

  const paidOrder = rows[0];
  const amountRupees = input.amountRupees ?? paidOrder.amount;

  // Capture the legacy gateway subscription id BEFORE activating (the
  // account may still hold one from the old Subscriptions model), so we
  // can cancel it afterwards and never leave a recurring charge running.
  const previousGatewaySubscriptionId = await loadGatewaySubscriptionId(order.account_id);

  // The real activation. Idempotent on the payment reference inside.
  const { subscription, applied } = await activateSubscription({
    accountId: order.account_id,
    planId: paidOrder.plan_id as PlanKey,
    cycle: paidOrder.billing_cycle,
    gateway: 'razorpay',
    gatewayPaymentId: paymentId,
    gatewayOrderId: paidOrder.razorpay_order_id,
    gatewaySubscriptionId: null,
    amount: amountRupees,
    currency: input.currency ?? paidOrder.currency,
    referenceTime: input.referenceTime ?? new Date(),
    idempotent: true,
  });

  // Belt-and-braces: a legacy recurring subscription is cancelled once the
  // new one-off payment is active, so the customer is never double-charged.
  if (applied && input.cancel && previousGatewaySubscriptionId) {
    const settled = await settlePreviousGatewaySubscription({
      accountId: order.account_id,
      previousGatewaySubscriptionId,
      keepGatewaySubscriptionId: null,
      cancel: input.cancel,
    });
    if (settled.attempted && !settled.cancelled) {
      console.error(
        `[orders] legacy gateway subscription ${previousGatewaySubscriptionId} not cancelled for ${order.account_id}: ${settled.error ?? 'see gateway'}`,
      );
    }
  }

  return {
    applied,
    subscription,
    order: paidOrder,
    periodEnd: subscription?.current_period_end ?? null,
  };
}

async function readSubscription(accountId: string): Promise<SubscriptionRow | null> {
  const { data } = await supabaseAdmin()
    .from('subscriptions')
    .select(
      'account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at',
    )
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as SubscriptionRow | null) ?? null;
}

/* ------------------------------------------------------------------ *
 * Webhook event de-duplication (spec PART 3.3).
 * Insert-first: the unique primary key is the guard. A re-delivery
 * collides and the webhook acknowledges without acting again.
 * ------------------------------------------------------------------ */
export async function claimWebhookEvent(eventId: string, eventType?: string): Promise<boolean> {
  if (!eventId) return false;
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .insert({ event_id: eventId, event_type: eventType ?? null });
  // A 23505 unique violation means we have already processed this event.
  if (error) {
    if (error.code === '23505' || /duplicate key/i.test(error.message)) return false;
    // Any other error: fail OPEN to acting (return true) so a transient
    // DB hiccup does not silently drop a real payment; fulfilment itself
    // is idempotent, so a reprocess is harmless.
    console.error('[orders] webhook event claim error:', error.message);
    return true;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Status + history readers (PART 3.6 / 3.7), tenant-scoped by account.
 * ------------------------------------------------------------------ */
export interface OrderStatusResult {
  status: OrderStatus;
  planName: string | null;
  cycle: BillingCycle;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  periodEnd: string | null;
  paymentId: string | null;
  failureReason: string | null;
}

/**
 * Read one order's status for the polling UI. Enforces ownership via the
 * caller's accountId. When the order is paid we also surface the live
 * period end so the "active until <date>" line can be shown the moment
 * the webhook (not just verify) lands.
 */
export async function getOrderStatus(
  orderId: string,
  accountId: string,
): Promise<OrderStatusResult | null> {
  const order = await loadOrderById(orderId);
  if (!order || order.account_id !== accountId) return null;
  const sub = await readSubscription(order.account_id);
  return {
    status: order.status,
    planName: order.plan_name_snapshot,
    cycle: order.billing_cycle,
    amount: Number(order.amount),
    currency: order.currency,
    method: order.payment_method,
    periodEnd: order.status === 'paid' ? sub?.current_period_end ?? null : null,
    paymentId: order.razorpay_payment_id,
    failureReason: order.failure_reason,
  };
}

export interface PaymentHistoryRow {
  id: string;
  created_at: string | null;
  plan_name: string | null;
  billing_cycle: BillingCycle;
  amount: number;
  currency: string;
  status: OrderStatus;
  payment_method: PaymentMethod | null;
  payment_id: string | null;
}

/**
 * Payment history for the billing tab (date, plan, cycle, amount, method,
 * status, payment id), scoped to the account. Orders are the authoritative
 * record for the current flow; legacy `payment_transactions` with no
 * matching order (none exist pre-launch, but a fork may) are appended so
 * nothing disappears from an existing customer's history.
 */
export async function listPaymentHistory(
  accountId: string,
  limit = 100,
): Promise<PaymentHistoryRow[]> {
  const admin = supabaseAdmin();
  const [{ data: orders }, { data: legacy }] = await Promise.all([
    admin
      .from('payment_orders')
      .select('id,created_at,plan_name_snapshot,plan_id,billing_cycle,amount,currency,status,payment_method,razorpay_payment_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit),
    admin
      .from('payment_transactions')
      .select('id,created_at,plan_id,billing_cycle,amount,currency,status,gateway_payment_id')
      .eq('account_id', accountId)
      .eq('status', 'paid')
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const rows: PaymentHistoryRow[] = (orders ?? []).map((o) => ({
    id: o.id as string,
    created_at: (o.created_at as string) ?? null,
    plan_name: (o.plan_name_snapshot as string) ?? (o.plan_id as string) ?? null,
    billing_cycle: o.billing_cycle as BillingCycle,
    amount: Number(o.amount),
    currency: (o.currency as string) ?? 'INR',
    status: o.status as OrderStatus,
    payment_method: normalizePaymentMethod(o.payment_method as string | null),
    payment_id: (o.razorpay_payment_id as string) ?? null,
  }));

  // Legacy paid transactions that no order references (dedupe by payment
  // id) so an existing customer's history stays complete.
  const seenPayments = new Set(rows.map((r) => r.payment_id).filter(Boolean));
  for (const t of (legacy ?? []) as Record<string, unknown>[]) {
    const payId = (t.gateway_payment_id as string) ?? null;
    if (payId && seenPayments.has(payId)) continue;
    rows.push({
      id: t.id as string,
      created_at: (t.created_at as string) ?? null,
      plan_name: (t.plan_id as string) ?? null,
      billing_cycle: (t.billing_cycle as BillingCycle) ?? 'monthly',
      amount: Number(t.amount ?? 0),
      currency: (t.currency as string) ?? 'INR',
      status: 'paid',
      payment_method: null,
      payment_id: payId,
    });
  }

  rows.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
  return rows.slice(0, limit);
}
