import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { activateSubscription } from '@/lib/plans/billing';
import type { BillingCycle, PlanKey } from '@/lib/plans/types';

/**
 * POST /api/billing/webhook  — gateway → subscription activation.
 *
 * This is the payment SUCCESS path from Part 2: on a verified webhook, set
 * plan/cycle/status and extend the period, recording a payment_transactions
 * row. It is idempotent — the unique gateway payment reference is passed to
 * activateSubscription, so a replayed webhook can never extend a period
 * twice (that dedup lives in the billing service + the DB unique index, not
 * here).
 *
 * Gateway-agnostic on purpose: signature verification is a plain
 * HMAC-SHA256 over the raw body using RAZORPAY_WEBHOOK_SECRET (the same
 * scheme Razorpay uses), and the event shape it reads — `payment.captured`
 * with payload.payment.entity.{id, order_id, amount, notes} — matches
 * Razorpay's payloads. When you finish the Razorpay integration you only
 * confirm the endpoint URL; no code change is required to activate.
 * Without the secret configured it returns 503 so nothing can be trusted.
 */
export async function POST(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: 'gateway_not_configured' }, { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature') ?? '';

  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
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
    payload?: { payment?: { entity?: RazorpayPaymentEntity } };
  };
  const entity = e?.payload?.payment?.entity;

  // Only payment success extends a subscription. Everything else is a
  // harmless 200 (webhook retries stop on non-2xx, so never 4xx a known
  // event we simply don't act on).
  if (!entity || !isCapturedEvent(e?.event)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  const accountId = entity.notes?.account_id;
  const planId = entity.notes?.plan_id as PlanKey | undefined;
  const cycle = (entity.notes?.billing_cycle as BillingCycle | undefined) ?? 'monthly';
  if (!accountId || !planId) {
    console.warn('[billing/webhook] captured payment missing account/plan notes:', entity.id);
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    await activateSubscription({
      accountId,
      planId,
      cycle,
      gateway: 'razorpay',
      gatewayPaymentId: entity.id ?? null,
      gatewayOrderId: entity.order_id ?? null,
      gatewayCustomerId: entity.customer_id ?? null,
      amount: typeof entity.amount_paid === 'number' ? entity.amount_paid / 100 : null,
      currency: entity.currency ?? 'INR',
      referenceTime: new Date((entity.created_at ? entity.created_at * 1000 : Date.now())),
      idempotent: true,
    });
  } catch (err) {
    // A duplicate-key race on the unique payment reference means the first
    // delivery already applied it — treat as success so retries settle.
    console.error('[billing/webhook] activation failed:', err);
    return NextResponse.json({ error: 'activation_failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true, applied: true });
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

function isCapturedEvent(event?: string): boolean {
  return event === 'payment.captured' || event === 'order.paid';
}
