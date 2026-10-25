/**
 * GET /api/ashwini-control/vault — Plan Vault list.
 * Search / filters / sort / server paging + the range summary, all
 * computed in one request by lib/admin/vault (no mock data). Every
 * admin API repeats the owner guard itself — middleware alone is not
 * sufficient (spec Part 1.6).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOwnerApi } from '@/lib/admin/guard'
import { getVaultList, parseVaultQuery } from '@/lib/admin/vault'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireOwnerApi()
  if (!auth.ok) return auth.response

  try {
    const list = await getVaultList(auth.userId, parseVaultQuery(request.nextUrl.searchParams))
    return NextResponse.json(list, { headers: HEADERS })
  } catch (err) {
    console.error('[admin-api] vault list failed:', err)
    return NextResponse.json({ error: 'vault_unavailable' }, { status: 500, headers: HEADERS })
  }
}
