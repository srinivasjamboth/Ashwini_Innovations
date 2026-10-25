/**
 * GET /api/ashwini-control/members — Member Ledger page.
 * Server-side pagination/search/filter/sort; the URL query parameters
 * the page uses are read verbatim here so views stay shareable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getMemberPage, type MemberQuery } from '@/lib/admin/metrics'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  const sp = request.nextUrl.searchParams
  const query: MemberQuery = {
    page: Number(sp.get('page') ?? '1') || 1,
    q: sp.get('q') ?? undefined,
    sort: sp.get('sort') === 'oldest' ? 'oldest' : 'newest',
    subscription: (['free', 'monthly', 'yearly'] as const).includes(
      sp.get('subscription') as 'free' | 'monthly' | 'yearly',
    )
      ? (sp.get('subscription') as MemberQuery['subscription'])
      : undefined,
    plan: sp.get('plan') ?? undefined,
    status: sp.get('status') ?? undefined,
  }

  try {
    const page = await getMemberPage(auth.userId, query)
    return NextResponse.json(page, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] members failed:', err)
    return NextResponse.json({ error: 'members_unavailable' }, { status: 500, headers: HEADERS })
  }
}
