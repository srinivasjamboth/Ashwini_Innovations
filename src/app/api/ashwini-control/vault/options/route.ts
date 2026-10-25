/**
 * GET /api/ashwini-control/vault/options — plan options for the
 * filter chips and the update panel. Straight from the plans +
 * plan_prices tables (never hard-coded).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getVaultPlanOptions } from '@/lib/admin/vault'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  try {
    const options = await getVaultPlanOptions()
    return NextResponse.json(options, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] vault options failed:', err)
    return NextResponse.json({ error: 'vault_options_unavailable' }, { status: 500, headers: HEADERS })
  }
}
