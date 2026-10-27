import { NextResponse } from 'next/server';
import { getPlanCatalog } from '@/lib/plans/catalog';
import { yearlyBillingEnabled } from '@/lib/plans/config';

/**
 * GET /api/billing/plans
 *
 * Public pricing catalog, sourced from the database (Part 5: "render them
 * from the database"). The marketing pricing page, the in-app upgrade
 * modal and the billing tab all read this one endpoint, so prices and
 * limits shown are the same rows the enforcement engine uses.
 *
 * Cacheable: it changes only when the seed/admin edits plan rows. A short
 * public revalidation keeps the landing page fast without going stale.
 */
export async function GET() {
  try {
    const plans = await getPlanCatalog();
    return NextResponse.json(
      {
        plans,
        // Lets every surface hide the Monthly/Yearly toggle at once when the
        // operator switches yearly billing off. Per-plan availability is on
        // each card (`yearlyAvailable`).
        yearlyBilling: yearlyBillingEnabled(),
      },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } },
    );
  } catch (err) {
    console.error('[billing/plans] failed:', err);
    return NextResponse.json({ error: 'Could not load plans' }, { status: 500 });
  }
}
