/**
 * GET /api/ashwini-control/pulse — the Pulse dashboard bundle.
 * Guarded, server-side aggregates only, never cached anywhere.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getPulseBundle } from '@/lib/admin/metrics'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  try {
    const bundle = await getPulseBundle(auth.userId)
    return NextResponse.json(bundle, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] pulse failed:', err)
    return NextResponse.json({ error: 'metrics_unavailable' }, { status: 500, headers: HEADERS })
  }
}
