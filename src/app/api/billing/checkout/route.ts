import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getPlanCatalog } from '@/lib/plans/catalog';
import type { BillingCycle, PlanKey } from '@/lib/plans/types';

/**
 * POST /api/billing/checkout  — gateway seam (deferred).
 *
 * The subscription lifecycle around checkout is fully built (see
 * src/lib/plans/billing.ts). Only the Razorpay ORDER CREATION is deferred
 * per the operator: "Razorpay I will implement afterwards."
 *
 * This route validates the requested plan + cycle and resolves the account,
 * then refuses with 503 `gateway_not_configured` unless Razorpay keys are
 * present. When you add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET, fill the
 * clearly-marked SEAM block below with the order-create call and return the
 * order + key id to the client; the webhook route already handles turning a
 * captured payment into an activated subscription.
 */
export async function POST(request: Request) {
  try {
    // requireRole enforces auth + admin. The resolved context (account,
    // supabase client) is what the Razorpay order-create SEAM below will
    // consume once implemented — intentionally not bound until then.
    await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const planId = typeof body?.planId === 'string' ? (body.planId as PlanKey) : null;
  const cycle = body?.cycle === 'yearly' ? 'yearly' : 'monthly';

  if (!planId) {
    return NextResponse.json({ error: 'planId is required' }, { status: 400 });
  }

  // Validate the plan/cycle exists and is a paid offering.
  const catalog = await getPlanCatalog();
  const plan = catalog.find((p) => p.id === planId);
  if (!plan || !plan.isPaid) {
    return NextResponse.json({ error: 'Unknown or free plan' }, { status: 400 });
  }
  const amount = plan.prices[cycle as BillingCycle];
  if (!amount || amount <= 0) {
    return NextResponse.json({ error: 'Plan has no price for that cycle' }, { status: 400 });
  }

  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

  // ---- SEAM: Razorpay order creation goes here when the keys are set. ----
  //   const order = await razorpay.orders.create({
  //     amount: Math.round(amount * 100), currency: plan.currency,
  //     notes: { account_id: ctx.accountId, plan_id: planId, billing_cycle: cycle },
  //   });
  //   return NextResponse.json({ keyId, orderId: order.id, amount, currency: plan.currency });
  // -----------------------------------------------------------------------
  if (!keyId || !keySecret) {
    return NextResponse.json(
      {
        error: 'gateway_not_configured',
        message: 'Payments are not enabled yet. Configure Razorpay to subscribe.',
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      error: 'gateway_integration_pending',
      message: 'Razorpay keys are set but order creation is not wired yet.',
      keyId,
      planId,
      cycle,
      amount,
      currency: plan.currency,
    },
    { status: 501 },
  );
}
