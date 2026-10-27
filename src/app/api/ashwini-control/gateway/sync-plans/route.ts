/**
 * POST /api/ashwini-control/gateway/sync-plans
 *
 * Create (or re-find) the Razorpay plan for every priced offering that has
 * no `gateway_plan_id` yet, and store the ids on the price rows.
 *
 * Why a route and not a migration: a migration cannot reach the network.
 * The ids are gateway data, so the gateway must mint them and the database
 * must remember them — after that, `plan_prices` stays the single source of
 * truth the pricing cards, checkout and the vault all read.
 *
 * Safe to run repeatedly: a row that already has an id is left alone, and a
 * row whose id was lost re-finds the plan it created earlier by name before
 * making a new one (no duplicate gateway plans).
 *
 * A missing yearly gateway id is not an error — it is what keeps that plan's
 * yearly option disabled in the UI instead of showing a broken checkout.
 */

import { NextResponse } from 'next/server';
import { requireOwnerApi } from '@/lib/admin/guard';
import { supabaseAdmin } from '@/lib/plans/admin-client';
import { getPlanCatalog } from '@/lib/plans/catalog';
import {
  ensureGatewayPlan,
  razorpayConfigured,
  storeGatewayPlanId,
  type GatewayCycle,
} from '@/lib/plans/gateway/razorpay';

export const dynamic = 'force-dynamic';

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

interface SyncResult {
  plan: string;
  cycle: GatewayCycle;
  status: 'kept' | 'created' | 'failed';
  gatewayPlanId?: string;
  error?: string;
}

export async function POST(): Promise<NextResponse> {
  const auth = await requireOwnerApi();
  if (!auth.ok) return auth.response;

  if (!razorpayConfigured()) {
    return NextResponse.json(
      { error: 'gateway_not_configured', message: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET' },
      { status: 503, headers: HEADERS },
    );
  }

  try {
    const catalog = await getPlanCatalog();
    const results: SyncResult[] = [];

    for (const plan of catalog) {
      // Free trial is never sold through a gateway.
      if (!plan.isPaid) continue;

      for (const cycle of ['monthly', 'yearly'] as GatewayCycle[]) {
        const amount = plan.prices[cycle];
        if (!amount || amount <= 0) {
          results.push({ plan: plan.id, cycle, status: 'failed', error: 'no stored price for cycle' });
          continue;
        }
        const existing = plan.gatewayPlanIds[cycle] ?? null;
        if (existing) {
          results.push({ plan: plan.id, cycle, status: 'kept', gatewayPlanId: existing });
          continue;
        }
        try {
          const { gatewayPlanId, created } = await ensureGatewayPlan({
            planId: plan.id,
            cycle,
            planName: plan.name,
            amount,
            currency: plan.currency,
            existingGatewayPlanId: existing,
          });
          const stored = await storeGatewayPlanId(plan.id, cycle, gatewayPlanId);
          if (!stored.ok) {
            results.push({ plan: plan.id, cycle, status: 'failed', gatewayPlanId, error: `stored: ${stored.error}` });
            continue;
          }
          results.push({ plan: plan.id, cycle, status: created ? 'created' : 'kept', gatewayPlanId });
        } catch (err) {
          results.push({ plan: plan.id, cycle, status: 'failed', error: (err as Error).message });
        }
      }
    }

    const admin = supabaseAdmin();
    const { data: refreshed } = await admin
      .from('plan_prices')
      .select('plan_id,billing_cycle,gateway_plan_id');

    return NextResponse.json(
      {
        results,
        stored: (refreshed ?? []) as { plan_id: string; billing_cycle: string; gateway_plan_id: string | null }[],
        summary: {
          created: results.filter((r) => r.status === 'created').length,
          kept: results.filter((r) => r.status === 'kept').length,
          failed: results.filter((r) => r.status === 'failed').length,
        },
      },
      { headers: HEADERS },
    );
  } catch (err) {
    console.error('[admin-api] gateway sync-plans failed:', err);
    return NextResponse.json({ error: 'sync_failed' }, { status: 500, headers: HEADERS });
  }
}
