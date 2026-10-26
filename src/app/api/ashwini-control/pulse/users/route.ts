/**
 * GET /api/ashwini-control/pulse/users — one page of the Pulse
 * fresh-users table (spec Part 1B §4). Server-side, owner-guarded,
 * never cached. Its own `usersPage` / `usersPageSize` params keep it
 * independent of every other table on the dashboard.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getFreshUsersPage } from '@/lib/admin/metrics'
import { USERS_DEFAULT_PAGE_SIZE, USERS_PAGE_SIZES } from '@/lib/admin/constants'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  const sp = request.nextUrl.searchParams
  const page = Math.max(1, Number(sp.get('usersPage') ?? '1') || 1)
  // Clamp the size to the allowed set; an unknown value falls back to
  // the default rather than 500ing or leaking an arbitrary limit.
  const rawSize = Number(sp.get('usersPageSize') ?? USERS_DEFAULT_PAGE_SIZE) || USERS_DEFAULT_PAGE_SIZE
  const pageSize = (USERS_PAGE_SIZES as readonly number[]).includes(rawSize)
    ? rawSize
    : USERS_DEFAULT_PAGE_SIZE

  try {
    const result = await getFreshUsersPage(auth.userId, { page, pageSize })
    return NextResponse.json(result, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] pulse/users failed:', err)
    return NextResponse.json({ error: 'users_unavailable' }, { status: 500, headers: HEADERS })
  }
}
