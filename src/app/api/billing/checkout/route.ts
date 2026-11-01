import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { assertSameOrigin } from '@/lib/auth/csrf';
import { getPlanCatalog } from '@/lib/plans/catalog';
import { evaluatePurchaseChange } from '@/lib/plans/billing';
import {
  createRazorpayOrder,
  razorpayConfigured,
  razorpayKeyId,
  rupeesToPaise,
  type RazorpayOrderEntity,
} from '@/lib/plans/gateway/razorpay';
import { checkRazorpayConfigOnce } from '@/lib/plans/gateway/config-check';
import {
  createPaymentOrder,
  findReusableOrder,
  markOrderAttempted,
  type PaymentOrderRow,
} from '@/lib/plans/orders';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import type { BillingCycle, PlanKey } from '@/lib/plans/types';

export const dynamic = 'force-dynamic';

/** Reuse window for a still-open identical order (double-click guard). */
const REUSE_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/billing/checkout — open a Razorpay ORDER (UPI-ready).
 *
 * Body: { plan_key | planId | plan, billing_cycle | cycle }
 *
 * In order:
 *   1. Authorize (owner/admin only — an agent can't spend) + same-origin
 *      (CSRF) + a per-user rate limit.
 *   2. Resolve the offering from the DATABASE catalog; the server reads the
 *      price in rupees and NEVER trusts any amount from the client.
 *   3. Refuse the free trial, an inactive/unbuyable yearly cycle, a cycle
 *      with no price, and any change the existing plan rules block
 *      (downgrade during a paid yearly period).
 *   4. Reuse a still-open order for the same plan+cycle inside 10 minutes,
 *      so a double click cannot stack Razorpay orders or charges.
 *   5. Otherwise create the Razorpay Order at the stored price, persist it
 *      in `payment_orders`, and return everything checkout.js needs plus
 *      profile prefill.
 *
 * Nothing is activated from this response — that takes a verified
 * signature + gateway confirmation, or a verified webhook.
 */
export async function POST(request: Request) {
  let accountId: string;
  let userId: string;
  let profile: { full_name?: string; email?: string; phone?: string } | null = null;
  try {
    const ctx = await requireRole('admin');
    accountId = ctx.accountId;
    userId = ctx.userId;
    assertSameOrigin(request);

    const rl = checkRateLimit(`billing:checkout:${userId}`, RATE_LIMITS.billing);
    if (!rl.success) return rateLimitResponse(rl);

    const { data } = await ctx.supabase
      .from('profiles')
      .select('full_name,email,phone')
      .eq('user_id', userId)
      .maybeSingle();
    profile = (data as { full_name?: string; email?: string; phone?: string } | null) ?? null;
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  // Accept the documented `plan_key` plus the historical `planId`/`plan`
  // spellings so a stale client bundle never 400s mid-rollout.
  const rawPlan = body?.plan_key ?? body?.planId ?? body?.plan;
  const planId = typeof rawPlan === 'string' ? (rawPlan as PlanKey) : null;
  const rawCycle = body?.billing_cycle ?? body?.cycle;
  const cycle: BillingCycle = rawCycle === 'yearly' ? 'yearly' : 'monthly';

  if (!planId) {
    return NextResponse.json({ error: 'plan_key is required' }, { status: 400 });
  }

  const catalog = await getPlanCatalog();
  const plan = catalog.find((p) => p.id === planId);
  if (!plan || !plan.isPaid) {
    return NextResponse.json({ error: 'Unknown or free plan' }, { status: 400 });
  }

  if (cycle === 'yearly' && !plan.yearlyAvailable) {
    return NextResponse.json(
      {
        error: 'yearly_unavailable',
        code: 'yearly_unavailable',
        message: 'Yearly billing is not available for this plan yet',
      },
      { status: 400 },
    );
  }

  const amount = plan.prices[cycle];
  if (!amount || amount <= 0) {
    return NextResponse.json({ error: 'Plan has no price for that cycle' }, { status: 400 });
  }

  // No downgrade (or back to monthly) while a paid yearly period runs.
  const change = await evaluatePurchaseChange(accountId, planId, cycle);
  if (!change.allowed) {
    return NextResponse.json(
      {
        error: 'yearly_period_active',
        code: 'yearly_period_active',
        blockedUntil: change.blockedUntil ?? null,
        message: 'Your yearly plan runs until a later date.',
      },
      { status: 409 },
    );
  }

  // Gateway configuration gate. Log the boot-style warning lazily too, so
  // dev (where instrumentation.register() does not run) still surfaces it.
  checkRazorpayConfigOnce();
  if (!razorpayConfigured() || !razorpayKeyId()) {
    return NextResponse.json(
      {
        error: 'gateway_not_configured',
        code: 'gateway_not_configured',
        message: 'Payments are not enabled yet. Configure Razorpay to subscribe.',
      },
      { status: 503 },
    );
  }

  // Reuse an open order for the same plan+cycle inside the window.
  const reusable = await findReusableOrder(accountId, planId, cycle, REUSE_WINDOW_MS);
  if (reusable) {
    await markOrderAttempted(reusable.id);
    return NextResponse.json(
      buildResponse(reusable.razorpay_order_id, reusable.id, amount, cycle, plan, profile, true),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Fresh Razorpay order + local record.
  const receipt = buildReceipt(planId, cycle, accountId);
  let gateway: RazorpayOrderEntity;
  try {
    gateway = await createRazorpayOrder({
      amountRupees: amount,
      currency: plan.currency,
      receipt,
      notes: { account_id: accountId, plan_id: planId, billing_cycle: cycle },
    });
  } catch (err) {
    console.error('[billing/checkout] order creation failed:', err);
    return NextResponse.json(
      { error: 'gateway_unavailable', message: 'Payment gateway could not be reached' },
      { status: 502 },
    );
  }

  let local: PaymentOrderRow;
  try {
    local = await createPaymentOrder({
      accountId,
      userId,
      planId,
      planName: plan.name,
      cycle,
      amountRupees: amount,
      currency: plan.currency,
      razorpayOrderId: gateway.id,
      receipt,
    });
  } catch (err) {
    console.error('[billing/checkout] local order record failed:', err);
    return NextResponse.json(
      { error: 'order_persist_failed', message: 'Could not record the checkout' },
      { status: 500 },
    );
  }

  return NextResponse.json(
    buildResponse(gateway.id, local.id, amount, cycle, plan, profile, false),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

// Build the checkout.js payload + display fields from the server-authoritative
// order data. The amount for checkout.js is paise; every stored/display value
// is rupees.
function buildResponse(
  razorpayOrderId: string,
  orderId: string,
  amountRupees: number,
  cycle: BillingCycle,
  plan: { name: string; currency: string },
  profile: { full_name?: string; email?: string; phone?: string } | null,
  reused: boolean,
) {
  return {
    mode: 'order',
    gateway: 'razorpay',
    // checkout.js needs the publishable key + the order id + amount(paise).
    keyId: razorpayKeyId(),
    razorpayOrderId,
    orderId,
    amount: amountRupees, // rupees, for display / receipts
    amountPaise: rupeesToPaise(amountRupees), // for checkout.js `amount`
    currency: plan.currency,
    description: `${plan.name} plan, ${cycle === 'yearly' ? 'Yearly' : 'Monthly'}`,
    reused,
    prefill: {
      name: profile?.full_name ?? '',
      email: profile?.email ?? '',
      // International format, digits only (Razorpay strips the +).
      contact: (profile?.phone ?? '').replace(/[^0-9]/g, ''),
    },
  };
}

/** Reconciliation receipt, kept under Razorpay's 40-character limit and
 *  unique per attempt (a fresh order gets a fresh tag). */
function buildReceipt(planId: string, cycle: BillingCycle, accountId: string): string {
  const seed = Date.now().toString(36).slice(-6);
  const tag = `${planId}.${cycle === 'yearly' ? 'y' : 'm'}.${accountId.slice(0, 8)}.${seed}`;
  return tag.slice(0, 40);
}
