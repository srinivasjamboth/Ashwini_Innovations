"use client";

// ============================================================
// startCheckout — the ONE client-side checkout flow (spec PART 4).
//
// Every Subscribe / Upgrade / Switch-to-yearly / Renew button in the app
// routes through `runCheckout` here, so the create-order → open-sheet →
// verify → poll logic exists exactly once and can never diverge between the
// pricing page, the upgrade modal and the billing tab.
//
// It is deliberately framework-free (no React) so a hook can own UI state
// around it. `useCheckout` wraps this and exposes phase + a refresh.
//
// Trust model mirrored on the client (the real guarantees are server-side):
//   · the client sends ONLY { plan_key, billing_cycle } — never an amount.
//   · the sheet is opened with the order id + amount the SERVER returned.
//   · "success" is only ever claimed after the server's /verify returns paid
//     (signature + gateway confirmation), or the status poll sees `paid`
//     (the webhook/reconcile landed). A closed sheet is NOT success.
// ============================================================

import { openRazorpayOrder } from "@/lib/plans/gateway/razorpay-client";

export type CheckoutPhase = "idle" | "creating" | "open" | "confirming";

export type CheckoutOutcome =
  | { status: "success"; planName: string | null; cycle: string | null; periodEnd: string | null }
  | { status: "failed"; reason: string | null; charged: boolean }
  | { status: "cancelled" }
  | { status: "pending"; paymentId: string | null; message: "confirming" | "reconcile" }
  | { status: "error"; code: string; message: string };

/** The JSON the /api/billing/checkout route returns for a fresh/reused order. */
interface CheckoutResponse {
  mode?: string;
  keyId?: string;
  razorpayOrderId?: string;
  orderId?: string;
  amount?: number;
  amountPaise?: number;
  currency?: string;
  description?: string;
  reused?: boolean;
  prefill?: { name?: string; email?: string; contact?: string };
  // error surface
  error?: string;
  code?: string;
  message?: string;
  blockedUntil?: string | null;
}

interface OrderStatusResponse {
  status: "created" | "attempted" | "paid" | "failed" | "cancelled";
  planName?: string | null;
  cycle?: string | null;
  periodEnd?: string | null;
  paymentId?: string | null;
  failureReason?: string | null;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes (spec PART 4 UPI-pending)

/**
 * Run the whole checkout for one (plan, cycle). `onPhase` reports UI state so
 * the button can show a spinner / "Confirming your payment..." without the
 * caller duplicating any of this.
 */
export async function runCheckout(
  planKey: string,
  cycle: "monthly" | "yearly",
  onPhase?: (phase: CheckoutPhase) => void,
): Promise<CheckoutOutcome> {
  onPhase?.("creating");

  // 1. Ask the server to create (or reuse) the order at the STORED price.
  let checkoutRes: Response;
  try {
    checkoutRes = await fetch("/api/billing/checkout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: planKey, billing_cycle: cycle }),
    });
  } catch {
    return { status: "error", code: "network", message: "Could not reach the payment service." };
  }

  const order = (await checkoutRes.json().catch(() => ({}))) as CheckoutResponse;
  if (!checkoutRes.ok || !order.keyId || !order.razorpayOrderId || !order.orderId) {
    return mapCheckoutError(order, checkoutRes.status);
  }

  // 2. Open Razorpay Checkout (UPI-first) with the SERVER's order.
  const callbackUrl = `${window.location.origin}/api/billing/callback`;
  let outcome;
  onPhase?.("open");
  try {
    outcome = await openRazorpayOrder({
      keyId: order.keyId,
      orderId: order.razorpayOrderId,
      amountPaise: order.amountPaise ?? 0,
      currency: order.currency ?? "INR",
      description: order.description,
      prefill: order.prefill,
      callbackUrl,
    });
  } catch {
    return { status: "error", code: "checkout_unavailable", message: "Payment window could not be opened." };
  }

  // 3a. Sheet dismissed: NOT a success. A UPI approval can still settle after
  // the sheet is gone, so poll briefly before calling it cancelled.
  if (outcome.status === "cancelled") {
    return confirmViaPoll(order.orderId, /* window */ POLL_INTERVAL_MS * 3);
  }

  // 3b. JS handler fired — verify server-side, then activate/confirm.
  onPhase?.("confirming");
  const verify = await verifyPayment(outcome.result);

  if (verify.status === "paid") {
    return {
      status: "success",
      planName: verify.planName ?? order.description ?? null,
      cycle: verify.cycle ?? cycle,
      periodEnd: verify.periodEnd ?? null,
    };
  }
  if (verify.status === "failed") {
    return { status: "failed", reason: verify.reason ?? null, charged: false };
  }
  // authorized / pending / signature-confirmed-but-unsettled: keep confirming.
  return confirmViaPoll(order.orderId, POLL_TIMEOUT_MS);
}

// ---- helpers ----------------------------------------------------------

/** POST /api/billing/verify and normalise its decision. */
async function verifyPayment(result: {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}): Promise<
  | { status: "paid"; planName?: string | null; cycle?: string | null; periodEnd?: string | null }
  | { status: "failed"; reason?: string | null }
  | { status: "pending" }
> {
  try {
    const res = await fetch("/api/billing/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      applied?: boolean;
      planName?: string | null;
      cycle?: string | null;
      periodEnd?: string | null;
      error?: string;
      reason?: string | null;
    };
    if (res.ok && (body.status === "paid" || body.applied)) {
      return { status: "paid", planName: body.planName, cycle: body.cycle, periodEnd: body.periodEnd };
    }
    // A definitive gateway rejection — money was not taken.
    if (res.status === 402 || body.error === "payment_failed" || body.error === "invalid_signature") {
      return { status: "failed", reason: body.reason ?? null };
    }
    // 202 (authorized / capture pending) or anything else: the webhook or the
    // reconcile job will settle it. Keep confirming rather than claiming.
    return { status: "pending" };
  } catch {
    return { status: "pending" };
  }
}

/**
 * Poll the order status until it is paid / failed, or `timeoutMs` elapses.
 * Drives both the "Confirming your payment..." window after a handler that
 * only authorized, and the post-cancel check for a UPI that settled late.
 */
async function confirmViaPoll(
  orderId: string,
  timeoutMs: number,
): Promise<CheckoutOutcome> {
  const deadline = Date.now() + timeoutMs;
  let lastPaymentId: string | null = null;

  while (Date.now() < deadline) {
    const s = await fetchStatus(orderId);
    if (s) {
      lastPaymentId = s.paymentId ?? lastPaymentId;
      if (s.status === "paid") {
        return {
          status: "success",
          planName: s.planName ?? null,
          cycle: s.cycle ?? null,
          periodEnd: s.periodEnd ?? null,
        };
      }
      if (s.status === "failed") {
        return { status: "failed", reason: s.failureReason ?? null, charged: false };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Ran out of time. If a payment id ever showed up the money is likely
  // moving and the webhook/reconcile will finish it → the "will activate
  // automatically, contact support with your payment id" branch. Otherwise
  // the order is simply still open → the customer can retry the same order.
  return {
    status: "pending",
    paymentId: lastPaymentId,
    message: lastPaymentId ? "reconcile" : "confirming",
  };
}

async function fetchStatus(orderId: string): Promise<OrderStatusResponse | null> {
  try {
    const res = await fetch(`/api/billing/orders/${orderId}/status`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as OrderStatusResponse;
  } catch {
    return null;
  }
}

/** Turn a checkout-route failure into the right UI outcome + copy. */
function mapCheckoutError(order: CheckoutResponse, httpStatus: number): CheckoutOutcome {
  const code = order.code ?? order.error ?? "checkout_failed";
  switch (code) {
    case "gateway_not_configured":
      return { status: "error", code, message: "Online payment isn't set up yet. Please try again shortly." };
    case "yearly_period_active":
      return {
        status: "error",
        code,
        message: order.blockedUntil
          ? `Your yearly plan runs until ${formatDate(order.blockedUntil)}.`
          : "Your current plan period must end before this change.",
      };
    case "yearly_unavailable":
      return { status: "error", code, message: "Yearly billing is not available for this plan yet." };
    default:
      if (httpStatus === 401 || httpStatus === 403) {
        return { status: "error", code: "unauthorized", message: "Please sign in to subscribe." };
      }
      if (httpStatus === 429) {
        return { status: "error", code: "rate_limited", message: "Too many attempts. Please wait a moment." };
      }
      return { status: "error", code, message: "Could not start the payment. Please try again." };
  }
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
