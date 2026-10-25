import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getEntitlements } from '@/lib/plans/entitlements';
import { FEATURE_FLAGS, LIMIT_FEATURES, UNLIMITED, type FeatureFlag, type LimitFeature } from '@/lib/plans/config';

/**
 * GET /api/billing/entitlements
 *
 * The caller's account snapshot for the usePlan hook and the billing tab:
 * plan, cycle, effective status, expiry date, limits, usage, plus the two
 * derived helpers the UI needs (remaining per limit, isFeatureAllowed per
 * flag). Computed server-side from the same getEntitlements the API
 * enforces with, so what the banner/modal shows == what the backend does.
 *
 * Readable by any account role (a viewer needs to know the account is
 * expired to show the banner), even though only owners/admins can act on
 * it.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const ent = await getEntitlements(ctx.accountId);

    const remaining: Partial<Record<LimitFeature, number>> = {};
    for (const f of LIMIT_FEATURES) {
      const limit = ent.limits[f];
      const current = ent.usage[f] ?? 0;
      remaining[f] = limit === undefined || limit === UNLIMITED ? Infinity : Math.max(0, limit - current);
    }

    const featuresAllowed: Partial<Record<FeatureFlag, boolean>> = {};
    for (const f of FEATURE_FLAGS) {
      featuresAllowed[f] = ent.effectiveStatus !== 'expired' && ent.features[f] !== false;
    }

    return NextResponse.json(
      {
        accountId: ent.accountId,
        plan: ent.plan,
        planName: ent.planName,
        cycle: ent.cycle,
        status: ent.status,
        effectiveStatus: ent.effectiveStatus,
        periodStart: ent.periodStart,
        periodEnd: ent.periodEnd,
        trialClaimedAt: ent.trialClaimedAt,
        limits: ent.limits,
        limitPeriods: ent.limitPeriods,
        usage: ent.usage,
        remaining,
        features: ent.features,
        featuresAllowed,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[billing/entitlements] failed:', err);
    return NextResponse.json({ error: 'Could not load entitlements' }, { status: 500 });
  }
}
