import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getPlanCatalog } from '@/lib/plans/catalog';
import { evaluatePurchaseChange } from '@/lib/plans/billing';
import {
  createGatewaySubscription,
  ensureGatewayPlan,
  razorpayConfigured,
  razorpayKeyId,
  storeGatewayPlanId,
} from '@/lib/plans/gateway/razorpay';
import type { BillingCycle, PlanKey } from '@/lib/plans/types';

/**
 * POST /api/billing/checkout — start a Razorpay SUBSCRIPTION.
 *
 * Body: { planId | plan, cycle?: 'monthly' | 'yearly' }
 *
 * What it does, in order:
 *   1. Authorizes the caller (account admin only — an agent can't spend).
 *   2. Resolves the offering from the DATABASE catalog, so a price or a
 *      limit that changed in the DB is respected here and nowhere else.
 *   3. Refuses a yearly checkout for a plan whose yearly price row or yearly
 *      figures are missing (`yearly_unavailable`) — never a checkout that
 *      cannot complete — and refuses a downgrade that would throw away
 *      a paid yearly period (`yearly_period_active`, PART 4).
 *   4. Creates the gateway subscription at the STORED price for that cycle
 *      and returns the id + publishable key for checkout.js.
 *
 * Nothing is activated from this response. Activation happens only on the
 * verified `subscription.charged` webhook, so a tampered client can never
 * grant itself a plan.
 */
export async function POST(request: Request) {
  let accountId: string;
  try {
    const ctx = await requireRole('admin');
    accountId = ctx.accountId;
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  // The upgrade modal historically sent `plan`; accept both spellings so a
  // stale client bundle can never 400 (the modal is fixed too).
  const rawPlan = body?.planId ?? body?.plan;
  const planId = typeof rawPlan === 'string' ? (rawPlan as PlanKey) : null;
  const cycle: BillingCycle = body?.cycle === 'yearly' ? 'yearly' : 'monthly';

  if (!planId) {
    return NextResponse.json({ error: 'planId is required' }, { status: 400 });
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

  // PART 4: no downgrade (or switch back to monthly) while a paid yearly
  // period is still running — there is no proration, so that trade would
  // silently destroy a year the customer already paid for.
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

  if (!razorpayConfigured()) {
    return NextResponse.json(
      {
        error: 'gateway_not_configured',
        code: 'gateway_not_configured',
        message: 'Payments are not enabled yet. Configure Razorpay to subscribe.',
      },
      { status: 503 },
    );
  }

  // Neither cycle requires a STORED gateway plan id: it is created at the
  // gateway on first use and written back, so an account is never blocked by
  // a row that the gateway can supply (this is how monthly has always worked,
  // and yearly must not be held to a stricter bar). `yearlyAvailable` above
  // is the real safety check — figures + a yearly price row.
  let gatewayPlanId = plan.gatewayPlanIds[cycle] ?? null;
  if (!gatewayPlanId) {
    try {
      const ensured = await ensureGatewayPlan({
        planId,
        cycle,
        planName: plan.name,
        amount,
        currency: plan.currency,
      });
      gatewayPlanId = ensured.gatewayPlanId;
      const stored = await storeGatewayPlanId(planId, cycle, gatewayPlanId);
      if (!stored.ok) {
        console.error('[billing/checkout] gateway plan created but not stored:', stored.error);
      }
    } catch (err) {
      console.error('[billing/checkout] gateway plan creation failed:', err);
      return NextResponse.json(
        { error: 'gateway_unavailable', message: 'Payment gateway could not be reached' },
        { status: 502 },
      );
    }
  }

  try {
    const { subscriptionId } = await createGatewaySubscription({
      gatewayPlanId,
      accountId,
      planId,
      cycle,
    });
    return NextResponse.json({
      keyId: razorpayKeyId(),
      gateway: 'razorpay',
      mode: 'subscription',
      subscriptionId,
      planId,
      cycle,
      amount,
      currency: plan.currency,
    });
  } catch (err) {
    console.error('[billing/checkout] subscription creation failed:', err);
    return NextResponse.json(
      { error: 'gateway_unavailable', message: 'Payment gateway could not be reached' },
      { status: 502 },
    );
  }
}
