import { NextResponse } from 'next/server';
import {
  cancelGatewaySubscription,
  verifyPaymentSignature,
} from '@/lib/plans/gateway/razorpay';
import {
  fulfillPaidOrder,
  loadOrderByRazorpayId,
  markOrderFailed,
} from '@/lib/plans/orders';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/callback — the redirect / mobile / UPI-intent handshake
 * (spec PART 3.3b).
 *
 * When checkout.js is configured with a `callback_url` (needed for browsers
 * and in-app webviews where the JS `handler` cannot fire — UPI intent that
 * leaves the page and comes back, mobile redirects), Razorpay POSTs the
 * payment trio here, then the customer expects to land back in the app.
 *
 * This route MUST NOT depend on the session cookie: the POST arrives
 * cross-site (Razorpay's domain redirects the browser), and Supabase's auth
 * cookies are SameSite=Lax, so they are NOT attached. Identity comes purely
 * from the signature + the order stored in OUR database.
 *
 * Flow:
 *   1. Read the trio from the form body (fall back to the query string for a
 *      GET-style callback).
 *   2. Look up the order by its Razorpay id; the client's order id is only a
 *      key. Reject an unknown order.
 *   3. Verify HMAC-SHA256(`stored_order_id|payment_id`) with the KEY SECRET,
 *      timing-safe. Mismatch → mark failed, redirect `failed`. Nothing is
 *      activated on a bad signature.
 *   4. Activate through the ONE idempotent `fulfillPaidOrder` — safe to race
 *      the webhook/verify and to be hit twice by a reload.
 *   5. Redirect (GET) to the billing tab with a status parameter so the page
 *      can confirm + refresh the plan.
 */
export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}

async function handle(request: Request): Promise<NextResponse> {
  const origin = new URL(request.url).origin;
  const target = new URL('/settings', origin);
  target.searchParams.set('tab', 'billing');

  const params = await readParams(request);
  const paymentId = params.get('razorpay_payment_id') ?? '';
  const orderId = params.get('razorpay_order_id') ?? '';
  const signature = params.get('razorpay_signature') ?? '';

  if (!orderId) {
    target.searchParams.set('checkout', 'failed');
    return NextResponse.redirect(target);
  }

  const order = await loadOrderByRazorpayId(orderId);
  if (!order) {
    target.searchParams.set('checkout', 'failed');
    return NextResponse.redirect(target);
  }

  // Already paid (webhook/verify got here first) — land on the success view.
  if (order.status === 'paid') {
    target.searchParams.set('checkout', 'success');
    return NextResponse.redirect(target);
  }

  if (!paymentId || !verifyPaymentSignature(order.razorpay_order_id, paymentId, signature)) {
    await markOrderFailed(order.id, { paymentId: paymentId || null, reason: 'signature_mismatch' });
    target.searchParams.set('checkout', 'failed');
    return NextResponse.redirect(target);
  }

  try {
    const result = await fulfillPaidOrder({
      order,
      paymentId,
      cancel: cancelGatewaySubscription,
    });
    target.searchParams.set('checkout', result.applied ? 'success' : 'pending');
  } catch (err) {
    console.error('[billing/callback] fulfilment failed:', err);
    // Money was authorized/confirmed by signature but our activation hit a
    // transient error — the webhook/reconcile will finish it. Ask the UI to
    // keep confirming rather than lying about a failure.
    target.searchParams.set('checkout', 'pending');
  }
  return NextResponse.redirect(target);
}

/** Razorpay sends the callback as `application/x-www-form-urlencoded`; a GET
 *  variant is possible too. Read the body first, then fall back to the query. */
async function readParams(request: Request): Promise<URLSearchParams> {
  const query = new URL(request.url).searchParams;
  if (request.method === 'GET') return query;
  try {
    const form = new URLSearchParams(await request.text());
    // A form body wins; if it is empty (or a JSON body), fall back to query.
    if (form.toString().length > 0) return form;
  } catch {
    /* body already consumed or unreadable — use the query string */
  }
  return query;
}
