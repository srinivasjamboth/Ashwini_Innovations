import { NextResponse } from 'next/server';
import { cancelGatewaySubscription, verifyWebhookSignature } from '@/lib/plans/gateway/razorpay';
import {
  claimWebhookEvent,
  fulfillPaidOrder,
  loadOrderByRazorpayId,
  markOrderFailed,
  normalizePaymentMethod,
} from '@/lib/plans/orders';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/razorpay — the ORDERS-flow webhook (spec PART 3.3).
 *
 * Public: no session, no CSRF, no origin check. It is authenticated purely
 * by the `X-Razorpay-Signature` header — HMAC-SHA256 of the RAW request
 * body keyed with RAZORPAY_WEBHOOK_SECRET, compared in constant time. That
 * is the only thing that lets a request through to activation.
 *
 * We read `request.text()` (the raw bytes) BEFORE parsing, so the signature
 * covers exactly what Razorpay signed — a re-serialized JSON body would
 * differ byte-for-byte and fail verification.
 *
 * Contract with Razorpay:
 *   · Respond 200 fast. A non-2xx makes Razorpay retry, and a retry of an
 *     already-handled event is a harmless no-op (dedup + idempotent
 *     fulfilment), but we never want to look unhealthy.
 *   · De-duplicate on the event id — a re-delivery is acknowledged without
 *     acting again.
 *   · `order.paid`      → activate through the ONE idempotent fulfilment.
 *   · `payment.failed`  → store the reason + method, never touch the plan.
 *   · anything else     → ignore safely (200).
 *
 * Out-of-order / early: this can fire before the browser calls `/verify`
 * (UPI intent that settles after the tab closed). It looks the order up by
 * its Razorpay id in OUR database and activates from the STORED plan/amount,
 * so it works even with no browser round-trip and can never be talked into
 * a client-supplied plan.
 *
 * Legacy recurring (Subscriptions-model) customers are unaffected: those
 * events keep flowing to the untouched `/api/billing/webhook` handler.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature');

  if (!process.env.RAZORPAY_WEBHOOK_SECRET?.trim()) {
    // Unconfigured environment can never be talked into granting a plan.
    return NextResponse.json({ error: 'gateway_not_configured' }, { status: 503 });
  }
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(raw) as RazorpayEvent;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const eventName = event.event ?? '';
  const orderEntity = event.payload?.order?.entity;
  const paymentEntity = event.payload?.payment?.entity;

  // De-dup key: Razorpay's event id when present, otherwise a stable
  // per-entity key so a re-delivery of the same notification is caught even
  // if a given payload omits a top-level id.
  const dedupKey =
    event.id ??
    (eventName === 'payment.failed' && paymentEntity?.id
      ? `payment.failed:${paymentEntity.id}`
      : eventName === 'order.paid' && orderEntity?.id
        ? `order.paid:${orderEntity.id}`
        : null);

  if (dedupKey && !(await claimWebhookEvent(dedupKey, eventName))) {
    // Already processed — acknowledge without acting again.
    return NextResponse.json({ received: true, duplicate: true });
  }

  // --- order.paid : activate -------------------------------------------
  if (eventName === 'order.paid') {
    const razorpayOrderId = orderEntity?.id ?? paymentEntity?.order_id ?? null;
    if (!razorpayOrderId) {
      return NextResponse.json({ received: true, ignored: true });
    }
    const order = await loadOrderByRazorpayId(razorpayOrderId);
    if (!order) {
      // An order we never created (another account's, or a stray event).
      // Nothing to activate — acknowledge so Razorpay stops retrying.
      console.warn('[webhooks/razorpay] order.paid for unknown order', razorpayOrderId);
      return NextResponse.json({ received: true, ignored: true });
    }
    if (order.status === 'paid') {
      return NextResponse.json({ received: true, applied: false, duplicate: true });
    }

    const paymentId = paymentEntity?.id ?? `order:${razorpayOrderId}`;
    try {
      const result = await fulfillPaidOrder({
        order,
        paymentId,
        method: normalizePaymentMethod(paymentEntity?.method),
        currency: paymentEntity?.currency ?? order.currency,
        referenceTime: new Date((paymentEntity?.created_at ?? Math.floor(Date.now() / 1000)) * 1000),
        cancel: cancelGatewaySubscription,
      });
      return NextResponse.json({ received: true, applied: result.applied });
    } catch (err) {
      // 500 makes Razorpay retry; fulfilment is idempotent so the retry
      // lands cleanly once the transient cause clears.
      console.error('[webhooks/razorpay] order.paid fulfilment failed:', err);
      return NextResponse.json({ error: 'activation_failed' }, { status: 500 });
    }
  }

  // --- payment.failed : record, never activate -------------------------
  if (eventName === 'payment.failed') {
    const razorpayOrderId = paymentEntity?.order_id ?? null;
    if (!razorpayOrderId) {
      return NextResponse.json({ received: true, ignored: true });
    }
    const order = await loadOrderByRazorpayId(razorpayOrderId);
    if (order && order.status !== 'paid') {
      await markOrderFailed(order.id, {
        paymentId: paymentEntity?.id ?? null,
        method: normalizePaymentMethod(paymentEntity?.method),
        reason: paymentEntity?.error_description ?? paymentEntity?.error_code ?? 'payment failed',
      });
    }
    return NextResponse.json({ received: true, recorded: true });
  }

  // --- everything else : ignore safely ---------------------------------
  return NextResponse.json({ received: true, ignored: true });
}

interface RazorpayEvent {
  id?: string;
  event?: string;
  payload?: {
    order?: { entity?: { id?: string; status?: string } };
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        method?: string;
        status?: string;
        currency?: string;
        error_description?: string;
        error_code?: string;
        created_at?: number;
      };
    };
  };
}
