import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { assertSameOrigin } from '@/lib/auth/csrf';
import {
  capturePayment,
  fetchRazorpayPayment,
  paymentNeedsCapture,
  paymentSettled,
  rupeesToPaise,
  verifyPaymentSignature,
} from '@/lib/plans/gateway/razorpay';
import {
  fulfillPaidOrder,
  loadOrderByRazorpayId,
  markOrderFailed,
  normalizePaymentMethod,
  paiseToRupees,
} from '@/lib/plans/orders';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/verify — the browser's success-handler handshake.
 *
 * Body: { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 *
 * Trust model (spec PART 3.2):
 *   1. The order is looked up by its Razorpay id in OUR database; the
 *      client's order id is only a key, never a source of truth for amount
 *      or plan. The tenant check (order.account_id === caller's account)
 *      rejects verifying as another account.
 *   2. The signature is HMAC-SHA256(`order_id|payment_id`) with the key
 *      SECRET, timing-safe, over the STORED order id. Mismatch → reject,
 *      activate nothing.
 *   3. Before activating we confirm with Razorpay's API that the payment
 *      is captured (capturing an authorized one if needed) and that its
 *      amount + currency equal the stored order.
 *   4. Fulfilment goes through the idempotent `fulfillPaidOrder`, so a
 *      verify racing the `order.paid` webhook extends the period once.
 */
export async function POST(request: Request) {
  let accountId: string;
  let userId: string;
  try {
    const ctx = await requireRole('admin');
    accountId = ctx.accountId;
    userId = ctx.userId;
    assertSameOrigin(request);
    const rl = checkRateLimit(`billing:verify:${userId}`, RATE_LIMITS.billing);
    if (!rl.success) return rateLimitResponse(rl);
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const paymentId = typeof body?.razorpay_payment_id === 'string' ? body.razorpay_payment_id : '';
  const orderId = typeof body?.razorpay_order_id === 'string' ? body.razorpay_order_id : '';
  const signature = typeof body?.razorpay_signature === 'string' ? body.razorpay_signature : '';

  if (!paymentId || !orderId || !signature) {
    return NextResponse.json({ error: 'missing_payment_fields' }, { status: 400 });
  }

  const order = await loadOrderByRazorpayId(orderId);
  if (!order) {
    return NextResponse.json({ error: 'order_not_found' }, { status: 404 });
  }
  // Tenant scoping: this order must belong to the caller's account.
  if (order.account_id !== accountId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // Already paid — nothing to redo, report the settled result.
  if (order.status === 'paid') {
    return NextResponse.json(await statusPayload(order.id, order.account_id));
  }

  // Signature over the STORED order id + the payment id the client returned.
  if (!verifyPaymentSignature(order.razorpay_order_id, paymentId, signature)) {
    await markOrderFailed(order.id, { paymentId, reason: 'signature_mismatch' });
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  // Confirm with the gateway — never trust the browser's word for "paid".
  const payment = await fetchRazorpayPayment(paymentId);
  if (!payment || payment.order_id !== order.razorpay_order_id) {
    return NextResponse.json({ error: 'payment_not_confirmed' }, { status: 409 });
  }

  // Amount + currency must equal the stored order (rupees ×100 vs paise).
  const expectedPaise = rupeesToPaise(Number(order.amount));
  const gatewayPaise = Math.round(Number(payment.amount ?? 0));
  if (gatewayPaise !== expectedPaise || (payment.currency ?? 'INR') !== order.currency) {
    await markOrderFailed(order.id, { paymentId, reason: 'amount_currency_mismatch' });
    return NextResponse.json({ error: 'amount_mismatch' }, { status: 409 });
  }

  // Capture an authorized-only payment if automatic capture is off.
  let captured = paymentSettled(payment);
  if (!captured && paymentNeedsCapture(payment)) {
    const res = await capturePayment(payment.id, gatewayPaise, order.currency);
    captured = res.captured;
    if (!res.captured) {
      return NextResponse.json(
        { error: 'capture_pending', message: res.error ?? 'payment authorized, capture pending' },
        { status: 202 },
      );
    }
  }
  if (!captured) {
    if (payment.status === 'failed') {
      await markOrderFailed(order.id, {
        paymentId,
        method: normalizePaymentMethod(payment.method),
        reason: payment.error_description ?? 'payment failed',
      });
      return NextResponse.json({ error: 'payment_failed', reason: payment.error_description ?? null }, { status: 402 });
    }
    // Not yet settled (e.g. UPI still processing) — the webhook/reconcile
    // will finish it. Tell the client to keep confirming.
    return NextResponse.json({ error: 'payment_pending', status: payment.status ?? null }, { status: 202 });
  }

  try {
    const result = await fulfillPaidOrder({
      order,
      paymentId: payment.id,
      method: normalizePaymentMethod(payment.method),
      amountRupees: paiseToRupees(gatewayPaise),
      currency: payment.currency ?? order.currency,
      referenceTime: new Date((payment.created_at ?? Math.floor(Date.now() / 1000)) * 1000),
    });
    return NextResponse.json({
      applied: result.applied,
      status: 'paid',
      planName: order.plan_name_snapshot,
      cycle: order.billing_cycle,
      periodEnd: result.periodEnd,
    });
  } catch (err) {
    console.error('[billing/verify] fulfilment failed:', err);
    return NextResponse.json({ error: 'activation_failed' }, { status: 500 });
  }
}

// Reuse the shared status reader by importing lazily to avoid a cycle: the
// order status endpoint lives in orders.ts as getOrderStatus.
async function statusPayload(orderId: string, accountHint: string) {
  const { getOrderStatus } = await import('@/lib/plans/orders');
  const s = await getOrderStatus(orderId, accountHint);
  return {
    status: s?.status ?? 'paid',
    planName: s?.planName ?? null,
    cycle: s?.cycle ?? null,
    periodEnd: s?.periodEnd ?? null,
  };
}
