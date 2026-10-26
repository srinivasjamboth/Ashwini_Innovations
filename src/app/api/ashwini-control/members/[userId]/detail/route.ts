/**
 * GET /api/ashwini-control/members/[userId]/detail — the lazy payload for
 * one expanded Member Ledger row (spec Part 1): account name, connected
 * WhatsApp number + status, last active, contacts, campaigns, team members.
 * Owner-guarded, never cached; unknown / owner / non-customer id ⇒ 404.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getMemberDetail } from '@/lib/admin/metrics'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = { params: Promise<{ userId: string }> }

export async function GET(_request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  const { userId } = await ctx.params
  if (!UUID_RE.test(userId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
  }

  try {
    const detail = await getMemberDetail(auth.userId, userId)
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
    return NextResponse.json(detail, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] members/detail failed:', err)
    return NextResponse.json({ error: 'detail_unavailable' }, { status: 500, headers: HEADERS })
  }
}
