/**
 * Plan engine — order reconciliation (spec PART 3.5).
 *
 * A safety net for payments the app never heard about through the browser
 * or the webhook: a customer who paid and closed the tab, a webhook that
 * was misconfigured or arrived out of order, a UPI intent that settled
 * after the window was gone. A scheduled sweep compares still-open local
 * orders against Razorpay's live view and fulfils any that are paid.
 *
 * Only orders that are:
 *   · status created/attempted, AND
 *   · older than `minAgeMs` (give the webhook/verify the first shot), AND
 *   · younger than `maxAgeMs` (Razorpay orders expire; nothing after a day)
 * is examined. Fulfilment goes through the ONE `fulfillPaidOrder`, so a
 * payment settled here can never double-extend a period already extended
 * by a late verify or webhook.
 *
 * When the gateway gives no explicit payment id for a paid order we anchor
 * idempotency on `order:<razorpay_order_id>` — stable and unique per order,
 * and the order-row flip already guarantees exactly-once activation.
 */

import {
  cancelGatewaySubscription,
  fetchRazorpayOrder,
  orderFullyPaid,
} from './gateway/razorpay';
import { fulfillPaidOrder, loadOrderById, type PaymentOrderRow } from './orders';
import { supabaseAdmin } from './admin-client';

const MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCAN_LIMIT = 100;

export interface ReconcileReport {
  scanned: number;
  paid: number;
  activated: number;
  alreadyFulfilled: number;
  failed: number;
  errors: string[];
}

/** Orders created between (now - maxAge) and (now - minAge), open only. */
async function listStaleOrders(): Promise<PaymentOrderRow[]> {
  const now = Date.now();
  const { data, error } = await supabaseAdmin()
    .from('payment_orders')
    .select(
      'id,account_id,user_id,plan_id,plan_name_snapshot,billing_cycle,amount,currency,' +
        'razorpay_order_id,razorpay_payment_id,receipt,status,payment_method,failure_reason,' +
        'fulfilled_at,created_at,updated_at',
    )
    .in('status', ['created', 'attempted'])
    .lte('created_at', new Date(now - MIN_AGE_MS).toISOString())
    .gte('created_at', new Date(now - MAX_AGE_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) {
    console.error('[reconcile] stale order scan failed:', error.message);
    return [];
  }
  return (data ?? []) as unknown as PaymentOrderRow[];
}

export async function reconcileStaleOrders(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    scanned: 0,
    paid: 0,
    activated: 0,
    alreadyFulfilled: 0,
    failed: 0,
    errors: [],
  };

  const orders = await listStaleOrders();
  report.scanned = orders.length;

  for (const order of orders) {
    try {
      const gatewayOrder = await fetchRazorpayOrder(order.razorpay_order_id);
      if (!gatewayOrder) continue; // gateway unreachable — leave for the next sweep

      if (orderFullyPaid(gatewayOrder)) {
        report.paid += 1;
        // Prefer a real payment id if the gateway surfaced one on the order;
        // otherwise anchor on the order id (stable, unique per order).
        const paymentId =
          (gatewayOrder as { payment_id?: string }).payment_id ?? `order:${order.razorpay_order_id}`;
        const res = await fulfillPaidOrder({
          order,
          paymentId,
          cancel: cancelGatewaySubscription,
        });
        if (res.applied) report.activated += 1;
        else report.alreadyFulfilled += 1;
        continue;
      }

      // Gateway reports the order as not paid and Razorpay says it can no
      // longer be paid (expired / cancelled) → settle it locally as failed
      // so the UI stops polling. A transient "created" is left untouched.
      const status = (gatewayOrder.status ?? '').toLowerCase();
      if (status === 'expired' || status === 'part_paid') {
        const fresh = await loadOrderById(order.id);
        if (fresh && fresh.status !== 'paid') report.failed += 1;
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      report.errors.push(`${order.razorpay_order_id}: ${msg}`);
      console.error(`[reconcile] order ${order.razorpay_order_id} failed:`, msg);
    }
  }

  return report;
}
