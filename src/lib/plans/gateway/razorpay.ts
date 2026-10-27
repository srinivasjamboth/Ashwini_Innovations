/**
 * Razorpay gateway client (spec PART 2/4: "the current payment gateway
 * integration").
 *
 * Deliberately built on global `fetch` — NO new dependency, no new
 * framework, and nothing to install on Vercel or in the Docker image. The
 * endpoints used are all of Razorpay's v1 REST API with HTTP basic auth
 * (Key ID : Key Secret), which is exactly what the official SDK wraps.
 *
 * Model: Plans + Subscriptions (not one-off Orders).
 *   - one Razorpay plan per (plan_id, billing_cycle), period monthly/yearly
 *     with interval 1, at the STORED price for that cycle. The id lives in
 *     `plan_prices.gateway_plan_id`, so the DB is still the single source of
 *     truth and a plan is created at most once.
 *   - checkout creates a subscription from that plan and hands the id to
 *     checkout.js, which authorizes + charges it. Success is NOT trusted
 *     from the browser: the `subscription.charged` webhook is what
 *     activates the subscription (see /api/billing/webhook).
 *   - `total_count: 1` — we bill one period at a time, so there is no
 *     runaway recurring charge, and the existing Renew flow (activate
 *     extends from the previous period end) is the renewal path.
 *
 * Everything here is network-only: it never touches the plan engine's
 * invariants. Callers decide what to do with a failure.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const API_BASE = process.env.RAZORPAY_API_BASE?.trim() || 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 12_000;

export type GatewayCycle = 'monthly' | 'yearly';

export interface RazorpayPlanItem {
  id?: string;
  name?: string;
  amount?: number;
  currency?: string;
}
export interface RazorpayPlan {
  id: string;
  period?: string;
  interval?: number;
  item?: RazorpayPlanItem;
}
export interface RazorpaySubscription {
  id: string;
  plan_id?: string;
  status?: string;
  amount?: number;
  paid_amount?: number;
  notes?: Record<string, string> | null;
}

/** True when the secret keys exist. The UI never calls this; checkout does. */
export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
}

export function razorpayKeyId(): string | null {
  return process.env.RAZORPAY_KEY_ID?.trim() || null;
}

export function razorpayWebhookConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET?.trim());
}

/** Razorpay signs the RAW request body with the webhook secret. Compare in
 *  constant time; a missing header is a rejection, not a bypass. */
export function verifyWebhookSignature(raw: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) {
    return { ok: false, status: 0, message: 'Razorpay keys are not configured' };
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Razorpay wraps errors as {error:{description,code}}; keep it short —
      // these strings end up in operator logs, never in a customer message.
      let description = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { description?: string; code?: string } };
        description = [parsed.error?.code, parsed.error?.description].filter(Boolean).join(': ') || description;
      } catch {
        /* non-JSON body: keep the raw prefix */
      }
      return { ok: false, status: res.status, message: description };
    }
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message ?? 'network error' };
  }
}

/** Deterministic, human-readable gateway plan name — also the dedupe key
 *  when a stored id is missing (a re-run finds its own plan instead of
 *  piling up duplicates). */
export function gatewayPlanName(planId: string, cycle: GatewayCycle, currency: string): string {
  return `${planId}-${cycle} (${currency})`;
}

/**
 * Create the Razorpay plan for one (plan, cycle) at the STORED price.
 * Idempotent: an existing id is returned as-is, and when none is stored we
 * first look for a plan with our deterministic name before creating one.
 */
export async function ensureGatewayPlan(args: {
  planId: string;
  cycle: GatewayCycle;
  planName: string;
  amount: number;
  currency: string;
  existingGatewayPlanId?: string | null;
}): Promise<{ gatewayPlanId: string; created: boolean }> {
  const { planId, cycle, amount, currency } = args;
  if (args.existingGatewayPlanId) return { gatewayPlanId: args.existingGatewayPlanId, created: false };

  const amountInSubunits = Math.round(amount * 100);
  if (!Number.isFinite(amountInSubunits) || amountInSubunits <= 0) {
    throw new Error(`ensureGatewayPlan: bad amount for ${planId}/${cycle}`);
  }
  const name = gatewayPlanName(planId, cycle, currency);

  // Reuse a plan we created before but lost the id for.
  const listed = await call<{ entity: string; count?: number; items?: RazorpayPlan[] }>(
    'GET',
    '/plans?count=100',
  );
  if (listed.ok) {
    const match = (listed.data.items ?? []).find((p) => p.item?.name === name);
    if (match?.id) return { gatewayPlanId: match.id, created: false };
  }

  const created = await call<RazorpayPlan>('POST', '/plans', {
    period: cycle, // 'monthly' | 'yearly'
    interval: 1, // one period per cycle — flag 3: price = monthly x 12 for yearly
    item: {
      name,
      description: `${args.planName} — billed ${cycle}`,
      pre_paid: true,
      post_paid: false,
      amount: amountInSubunits,
      price: amountInSubunits,
      currency,
      quantity: 1,
    },
  });
  if (!created.ok) throw new Error(`create plan ${name} failed (${created.status}): ${created.message}`);
  if (!created.data.id) throw new Error(`create plan ${name}: gateway returned no id`);
  return { gatewayPlanId: created.data.id, created: true };
}

/**
 * Create a subscription for the account against a gateway plan.
 * The notes ride along on every webhook event for this subscription, which
 * is how the webhook knows which account/plan/cycle to activate — so they
 * are written here once and never re-derived from client input.
 */
export async function createGatewaySubscription(args: {
  gatewayPlanId: string;
  accountId: string;
  planId: string;
  cycle: GatewayCycle;
  quantity?: number;
}): Promise<{ subscriptionId: string; status: string }> {
  const res = await call<RazorpaySubscription>('POST', '/subscriptions', {
    plan_id: args.gatewayPlanId,
    quantity: args.quantity ?? 1,
    total_count: 1, // bill exactly one period; renewal is the next checkout
    customer_notify: 0, // the app emails the customer, not the gateway
    notes: {
      account_id: args.accountId,
      plan_id: args.planId,
      billing_cycle: args.cycle,
    },
  });
  if (!res.ok) {
    throw new Error(`create subscription failed (${res.status}): ${res.message}`);
  }
  if (!res.data.id) throw new Error('create subscription: gateway returned no id');
  return { subscriptionId: res.data.id, status: res.data.status ?? 'created' };
}

/** Fetch a subscription (used to trust gateway state over client state). */
export async function fetchGatewaySubscription(
  subscriptionId: string,
): Promise<RazorpaySubscription | null> {
  const res = await call<RazorpaySubscription>('GET', `/subscriptions/${subscriptionId}`);
  return res.ok ? res.data : null;
}

/**
 * Cancel a gateway subscription so the customer is never billed twice.
 * Idempotent: an already-cancelled / already-completed subscription is a
 * SUCCESS, not an error, so replaying a webhook can never fail the flow and
 * Razorpay's "not able to cancel" for a terminal subscription settles.
 */
export async function cancelGatewaySubscription(
  subscriptionId: string,
): Promise<{ cancelled: boolean; alreadyInactive?: boolean; error?: string }> {
  if (!subscriptionId) return { cancelled: false, alreadyInactive: true };

  const current = await fetchGatewaySubscription(subscriptionId);
  if (current && TERMINAL_SUBSCRIPTION_STATUSES.has(current.status ?? '')) {
    return { cancelled: true, alreadyInactive: true };
  }

  const res = await call<RazorpaySubscription>('POST', `/subscriptions/${subscriptionId}/cancel`, {
    cancel_at_period_end: false,
  });
  if (res.ok) {
    return { cancelled: true, alreadyInactive: res.data.status !== 'cancelled' };
  }
  // 4xx on something already terminal = nothing left to bill. Treat as done.
  const alreadyGone =
    res.status === 400 && /cancel|not able|paid|completed|terminal/i.test(res.message);
  if (alreadyGone) return { cancelled: true, alreadyInactive: true };
  return { cancelled: false, error: `(${res.status}) ${res.message}` };
}

/** Razorpay subscription states that cannot charge again. */
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(['cancelled', 'completed', 'expired', 'halted']);

/**
 * Persist a gateway plan id on its price row, so `plan_prices` stays the
 * single source of truth (cards read availability from it, checkout reads
 * the id from it). Additive: only `gateway_plan_id` / `updated_at` change.
 */
export async function storeGatewayPlanId(
  planId: string,
  cycle: GatewayCycle,
  gatewayPlanId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { supabaseAdmin } = await import('../admin-client');
  const { error } = await supabaseAdmin()
    .from('plan_prices')
    .update({ gateway_plan_id: gatewayPlanId, updated_at: new Date().toISOString() })
    .eq('plan_id', planId)
    .eq('billing_cycle', cycle);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Razorpay's client-side checkout script (loaded on demand, no bundle cost). */
export const RAZORPAY_CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
