import { describe, it, expect, vi, beforeEach } from 'vitest'

// ------------------------------------------------------------
// Tenancy + eager-validation coverage for POST /api/automations/[id]/edges.
//
// Same service-role tenancy gate as ./nodes (parent matched on
// account_id, GHSA-xvrq-88hg-44q6); the fake DB chain additionally
// enforces the `account_id` predicate on node lookups so a handler
// that dropped the filter would fail to resolve the endpoints — the
// canvas invariants (self-loop, starting-step target, condition
// handles) are then checked on top of a genuinely scoped read.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    callerAccountId: 'acc-new',
    inserts: [] as Record<string, unknown>[],
    recompiles: [] as string[],
  },
}))

const NODE_FIXTURES: Record<string, { id: string; type: string }> = {
  n1: { id: 'n1', type: 'text_button' },
  n2: { id: 'n2', type: 'add_tag' },
  c1: { id: 'c1', type: 'condition' },
  st: { id: 'st', type: 'starting_step' },
}

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: h.state.callerAccountId }),
  requireRole: async () => ({ accountId: h.state.callerAccountId }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}))

vi.mock('@/lib/automations/graph-store', () => ({
  getAutomationForAccount: async (_id: string, accountId: string) =>
    accountId === 'acc-old'
      ? { id: 'auto-1', account_id: 'acc-old', is_active: false }
      : null,
  // Empty graph — the prospective-cycle check only trips on real edges.
  loadGraph: async () => ({ nodes: [], edges: [] }),
  persistGraphAndSteps: async (id: string) => {
    h.state.recompiles.push(id)
    return null
  },
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = []
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: unknown) => (filters.push([col, val]), api),
        // The incoming-connection probe always reports "none".
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: async () => {
          if (table !== 'automation_nodes') return { data: null, error: null }
          const idF = filters.find((f) => f[0] === 'id')
          const accF = filters.find((f) => f[0] === 'account_id')
          // Emulate RLS-less scoping: a node only resolves inside its account.
          if (!accF || accF[1] !== 'acc-old') return { data: null, error: null }
          return { data: idF ? NODE_FIXTURES[idF[1] as string] ?? null : null, error: null }
        },
        insert: (row: Record<string, unknown>) => {
          h.state.inserts.push(row)
          return {
            select: () => ({
              single: async () => ({ data: { id: 'edge-1', ...row }, error: null }),
            }),
          }
        },
      }
      return api
    },
  }),
}))

import { POST } from './route'

const params = Promise.resolve({ id: 'auto-1' })

const postReq = (body: unknown) =>
  new Request('http://t/', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  h.state.callerAccountId = 'acc-new'
  h.state.inserts = []
  h.state.recompiles = []
})

describe('automations/[id]/edges tenancy + validation', () => {
  it('refuses a caller outside the automation account', async () => {
    const res = (await POST(
      postReq({ source_node_id: 'n1', target_node_id: 'n2' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(404)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('connects two owned nodes and recompiles steps', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'n1', target_node_id: 'n2' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(201)
    expect(h.state.inserts[0]).toMatchObject({
      automation_id: 'auto-1',
      account_id: 'acc-old',
      source_node_id: 'n1',
      target_node_id: 'n2',
      source_handle: null,
    })
    expect(h.state.recompiles).toContain('auto-1')
  })

  it('accepts a condition edge carrying a Yes handle', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'c1', target_node_id: 'n2', source_handle: 'yes' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(201)
    expect(h.state.inserts[0]).toMatchObject({ source_handle: 'yes' })
  })

  it('rejects a condition edge with no handle', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'c1', target_node_id: 'n2' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('rejects a plain node edge that carries a handle', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'n1', target_node_id: 'n2', source_handle: 'no' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('rejects a self-loop', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'n1', target_node_id: 'n1' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(400)
  })

  it('rejects connecting into the starting step', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'n1', target_node_id: 'st' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(400)
  })

  it('rejects endpoints that are not nodes of this automation', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ source_node_id: 'n1', target_node_id: 'ghost' }),
      { params },
    )) as unknown as { status: number }
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })
})
