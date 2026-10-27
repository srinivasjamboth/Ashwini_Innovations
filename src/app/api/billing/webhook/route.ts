import { NextResponse } from 'next/server';
import {
  activateSubscription,
  loadGatewaySubscriptionId,
  resolveOfferingByGatewayPlan,
  settlePreviousGatewaySubscription,
} from '@/lib/plans/billing';
import { cancelGatewaySubscription, verifyWebhookSignature } from '@/lib/plans/gateway/razorpay';
import { supabaseAdmin } from '@/lib/plans/admin-client';
import { invalidateEntitlements } from '@/lib/plans/entitlements';
import type { BillingCycle, PlanKey } from '@/lib/plans/types';

/**
 * POST /api/billing/webhook — the ONLY thing that can activate a plan.
 *
 * Razorpay signs the raw body with the webhook secret (HMAC-SHA256); without
 * a matching signature nothing is read, and without the secret configured the
 * route refuses everything (503) so an unverified environment can never be
 * talked into granting a plan.
 *
 * Handled events:
 *   · payment.captured / order.paid     — one-off payment (historic path)
 *   · subscription.charged              — a cycle was paid (monthly or yearly)
 *   · subscription.cancelled / .expired — the gateway side stopped renewing;
 *                                         we only forget the id, the customer
 *                                         keeps access until the PAID period
 *                                         end (never cut short mid-period)
 *
 * Idempotency: the gateway payment reference goes into `activateSubscription`
 * as the dedup key, so a replay (Razorpay retries aggressively) can never
 * extend a period twice or write a second payment row.
 *
 * Double billing (PART 4): the customer's PREVIOUS gateway subscription is
 * cancelled as soon as a new one becomes active — plan change or cycle
 * switch — and the cancellation is idempotent, so a replay settles quietly.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature') ?? '';

  if (!process.env.RAZORPAY_WEBHOOK_SECRET?.trim()) {
    return NextResponse.json({ error: 'gateway_not_configured' }, { status: 503 });
  }
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const e = event as {
    event?: string;
    payload?: {
      payment?: { entity?: RazorpayPaymentEntity };
      subscription?: { entity?: RazorpaySubscriptionEntity };
      order?: { entity?: { id?: string } };
    };
  };
  const eventName = e?.event ?? '';
  const payment = e?.payload?.payment?.entity;
  const subscription = e?.payload?.subscription?.entity;

  if (TERMINAL_SUBSCRIPTION_EVENTS.has(eventName)) {
    return forgetGatewaySubscription(eventName, subscription);
  }

  if (!isPaymentSuccessEvent(eventName)) {
    // Anything else (including subscription.pending / .auth) is a
    // harmless 200 — a non-2xx only makes Razorpay retry forever.
    return NextResponse.json({ received: true, ignored: true });
  }

  const notes = { ...subscription?.notes, ...payment?.notes };
  const accountId = notes.account_id;
  const gatewayPlanId = subscription?.plan_id ?? null;

  // The DB lookup outranks the gateway's notes for WHAT is being sold; the
  // notes only ever say WHO paid. (A note can be edited in the dashboard;
  // a plan id cannot silently change price.)
  const offering = await resolveOfferingByGatewayPlan(gatewayPlanId);
  const planId = (offering?.planId ?? (notes.plan_id as PlanKey | undefined)) ?? null;
  const cycle = (offering?.cycle ?? (notes.billing_cycle as BillingCycle | undefined)) ?? 'monthly';

  if (!accountId || !planId) {
    console.warn('[billing/webhook] payment event missing account/plan identity:', payment?.id ?? eventName);
    return NextResponse.json({ received: true, ignored: true });
  }

  if (!payment?.id && !subscription?.id) {
    // Nothing to dedup on — refuse rather than risk applying the same
    // payment twice.
    console.warn('[billing/webhook] event carries no identifiable entity:', eventName);
    return NextResponse.json({ received: true, ignored: true });
  }

  const paidAt = payment?.created_at ?? subscription?.charged_at;
  // Idempotency anchor. A subscription event always carries its payment, but
  // if a gateway ever delivers one without it, fall back to a stable
  // subscription+time reference — a NULL key would let a replay extend the
  // period twice.
  const paymentReference =
    payment?.id ?? (subscription?.id ? `sub:${subscription.id}:${paidAt ?? 0}` : null);
  // Captured BEFORE activation, because activation overwrites the column —
  // this is the id we may need to cancel so the old plan stops charging.
  const previousGatewaySubscriptionId = await loadGatewaySubscriptionId(accountId);

  try {
    const { applied } = await activateSubscription({
      accountId,
      planId,
      cycle,
      gateway: 'razorpay',
      gatewayPaymentId: paymentReference,
      gatewayOrderId: payment?.order_id ?? null,
      gatewaySubscriptionId: subscription?.id ?? null,
      gatewayCustomerId: payment?.customer_id ?? subscription?.customer_id ?? null,
      amount: subunitsToMajor(payment?.amount_paid ?? payment?.amount ?? subscription?.paid_amount ?? subscription?.amount),
      currency: payment?.currency ?? 'INR',
      referenceTime: new Date(paidAt ? paidAt * 1000 : Date.now()),
      idempotent: true,
    });

    if (applied) {
      const settled = await settlePreviousGatewaySubscription({
        accountId,
        previousGatewaySubscriptionId,
        keepGatewaySubscriptionId: subscription?.id ?? null,
        cancel: cancelGatewaySubscription,
      });
      if (settled.attempted) {
        console.info(
          `[billing/webhook] previous gateway subscription ${previousGatewaySubscriptionId} cancel -> ${settled.cancelled ? 'cancelled' : 'FAILED (operator action required)'}`,
        );
      }
      return NextResponse.json({ received: true, applied: true });
    }
    // Duplicate reference: nothing was extended. Replaying a webhook must be
    // a no-op, so we stop here (and never re-cancel anything).
    return NextResponse.json({ received: true, applied: false, duplicate: true });
  } catch (err) {
    // A duplicate-key race on the unique payment reference means the first
    // delivery already applied it — 500 keeps Razorpay retrying, and the
    // retry lands in the `applied: false` branch above.
    console.error('[billing/webhook] activation failed:', err);
    return NextResponse.json({ error: 'activation_failed' }, { status: 500 });
  }
}

/** Gateway says its side stopped renewing. Access is NOT cut short: the
 *  customer keeps what they paid for until the stored period end, so we only
 *  drop the id (a stale id would otherwise be retried by the cancel guard). */
async function forgetGatewaySubscription(
  eventName: string,
  subscription: RazorpaySubscriptionEntity | undefined,
): Promise<NextResponse> {
  const id = subscription?.id;
  if (!id) return NextResponse.json({ received: true, ignored: true });
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('subscriptions')
    .update({ gateway_subscription_id: null, updated_at: new Date().toISOString() })
    .eq('gateway_subscription_id', id)
    .select('account_id');
  if (error) {
    console.error(`[billing/webhook] ${eventName}: could not forget ${id}:`, error.message);
    return NextResponse.json({ received: true }, { status: 200 });
  }
  for (const row of (data ?? []) as { account_id: string }[]) invalidateEntitlements(row.account_id);
  return NextResponse.json({ received: true, event: eventName, forgotten: true });
}

/** Razorpay amounts are in the smallest unit (paise). */
function subunitsToMajor(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value / 100 : null;
}

interface RazorpayPaymentEntity {
  id?: string;
  order_id?: string;
  customer_id?: string;
  amount?: number;
  amount_paid?: number;
  currency?: string;
  status?: string;
  created_at?: number;
  notes?: { account_id?: string; plan_id?: string; billing_cycle?: string } | null;
}

interface RazorpaySubscriptionEntity {
  id?: string;
  plan_id?: string;
  customer_id?: string;
  status?: string;
  amount?: number;
  paid_amount?: number;
  charged_at?: number;
  created_at?: number;
  notes?: { account_id?: string; plan_id?: string; billing_cycle?: string } | null;
}

function isPaymentSuccessEvent(event: string): boolean {
  return (
    event === 'payment.captured' || event === 'order.paid' || event === 'subscription.charged'
  );
}

const TERMINAL_SUBSCRIPTION_EVENTS = new Set(['subscription.cancelled', 'subscription.expired']);
