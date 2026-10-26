/**
 * GET /api/ashwini-control/members — Member Ledger page.
 * Server-side pagination/search/filter/sort; the URL query parameters
 * the page uses are read verbatim here so views stay shareable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getMemberPage, type MemberQuery } from '@/lib/admin/metrics'
import { LEDGER_DEFAULT_PAGE_SIZE, LEDGER_PAGE_SIZES } from '@/lib/admin/constants'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  const sp = request.nextUrl.searchParams
  // Entries per page: clamp to the allowed set; an unknown value falls
  // back to the default rather than 500ing or honouring an arbitrary
  // limit (spec Part 1: 10/25/50/100, default 25).
  const rawSize = Number(sp.get('pageSize') ?? LEDGER_DEFAULT_PAGE_SIZE) || LEDGER_DEFAULT_PAGE_SIZE
  const pageSize = (LEDGER_PAGE_SIZES as readonly number[]).includes(rawSize)
    ? rawSize
    : LEDGER_DEFAULT_PAGE_SIZE
  const from = sp.get('from')
  const to = sp.get('to')
  const query: MemberQuery = {
    page: Number(sp.get('page') ?? '1') || 1,
    pageSize,
    q: sp.get('q') ?? undefined,
    sort: sp.get('sort') === 'oldest' ? 'oldest' : 'newest',
    subscription: (['free', 'monthly', 'yearly'] as const).includes(
      sp.get('subscription') as 'free' | 'monthly' | 'yearly',
    )
      ? (sp.get('subscription') as MemberQuery['subscription'])
      : undefined,
    plan: sp.get('plan') ?? undefined,
    status: sp.get('status') ?? undefined,
    from: from && DATE_RE.test(from) ? from : null,
    to: to && DATE_RE.test(to) ? to : null,
  }

  try {
    const page = await getMemberPage(auth.userId, query)
    return NextResponse.json(page, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] members failed:', err)
    return NextResponse.json({ error: 'members_unavailable' }, { status: 500, headers: HEADERS })
  }
}
