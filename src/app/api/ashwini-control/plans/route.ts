/**
 * GET /api/ashwini-control/plans — Plan Vault bundle.
 * Plans come from the `plans` table (never hard-coded); while the
 * schema has no billing tables the bundle degrades to
 * { available: false, plans: [] } and the page renders the summary
 * Free-Users line plus an empty state.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getPlans } from '@/lib/admin/metrics'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  try {
    const bundle = await getPlans(auth.userId)
    return NextResponse.json(bundle, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] plans failed:', err)
    return NextResponse.json({ error: 'plans_unavailable' }, { status: 500, headers: HEADERS })
  }
}
