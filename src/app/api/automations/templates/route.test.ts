import { describe, it, expect, vi, beforeEach } from 'vitest'

// ------------------------------------------------------------
// GET /api/automations/templates
//
// The Automation builder's Template node loads through this route
// (server RLS client, account-scoped) instead of a direct browser →
// Supabase query, so it works for account members whose email isn't
// confirmed. We assert the tenant filter + APPROVED-only filter are
// applied and the rows are returned under `templates`.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    accountId: 'acc-1',
    filters: [] as { column: string; value: unknown }[],
    rows: [] as Record<string, unknown>[],
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

// requireRole hands back the RLS-scoped client + resolved account. The
// fake client records the .eq() chain so we can prove account_id +
// status filters ran, and returns the fixture rows.
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: h.state.accountId,
    supabase: {
      from: () => {
        // Thenable query builder: each `.eq()` records its column/value so
        // the test can prove the tenant + status filters ran, and awaiting
        // the chain resolves the fixture rows.
        interface Chain {
          select: () => Chain
          eq: (column: string, value: unknown) => Chain
          order: () => Chain
          then: (resolve: (v: unknown) => unknown) => unknown
        }
        const chain: Chain = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            h.state.filters.push({ column, value })
            return chain
          },
          order: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: h.state.rows, error: null }),
        }
        return chain
      },
    },
  }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}))

import { GET } from './route'

beforeEach(() => {
  h.state.accountId = 'acc-1'
  h.state.filters = []
  h.state.rows = []
})

describe('GET /api/automations/templates', () => {
  it('scopes by account_id and filters to APPROVED, returning { templates }', async () => {
    h.state.rows = [
      { id: 't1', name: 'welcome', language: 'en_US', status: 'APPROVED' },
    ]

    const res = (await GET()) as unknown as {
      body: { templates?: Record<string, unknown>[] }
      status: number
    }

    expect(res.status).toBe(200)
    expect(res.body.templates).toHaveLength(1)
    expect(h.state.filters).toContainEqual({ column: 'account_id', value: 'acc-1' })
    expect(h.state.filters).toContainEqual({ column: 'status', value: 'APPROVED' })
  })

  it('returns an empty list, not an error, when the account has no approved templates', async () => {
    const res = (await GET()) as unknown as {
      body: { templates?: unknown[] }
      status: number
    }
    expect(res.status).toBe(200)
    expect(res.body.templates).toEqual([])
  })
})
