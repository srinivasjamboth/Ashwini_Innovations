import { describe, it, expect, vi, beforeEach } from 'vitest'

// ------------------------------------------------------------
// Tenancy + validation coverage for POST/GET /api/automations/[id]/nodes.
//
// The handler runs on the service-role client (RLS bypassed), so the
// parent automation matched on `account_id` is the ONLY tenancy gate
// (GHSA-xvrq-88hg-44q6). graph-store is mocked so the guard's outcome
// is what we assert, not the DB plumbing.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    callerAccountId: 'acc-new',
    inserts: [] as Record<string, unknown>[],
    recompiles: [] as string[],
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

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: h.state.callerAccountId }),
  requireRole: async () => ({ accountId: h.state.callerAccountId }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}))

// The parent only resolves for the account that actually owns it.
vi.mock('@/lib/automations/graph-store', () => ({
  getAutomationForAccount: async (_id: string, accountId: string) =>
    accountId === 'acc-old'
      ? { id: 'auto-1', account_id: 'acc-old', is_active: false }
      : null,
  loadGraph: async () => ({ nodes: [], edges: [] }),
  persistGraphAndSteps: async (id: string) => {
    h.state.recompiles.push(id)
    return null
  },
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        h.state.inserts.push(row)
        return {
          select: () => ({
            single: async () => ({ data: { id: 'node-1', ...row }, error: null }),
          }),
        }
      },
    }),
  }),
}))

import { POST, GET } from './route'

const params = Promise.resolve({ id: 'auto-1' })

const postReq = (body: unknown) =>
  new Request('http://t/', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  h.state.callerAccountId = 'acc-new'
  h.state.inserts = []
  h.state.recompiles = []
})

describe('automations/[id]/nodes tenancy', () => {
  it('GET returns 404 and loads nothing for a cross-account caller', async () => {
    const res = (await GET(new Request('http://t/'), {
      params,
    })) as unknown as { status: number }
    expect(res.status).toBe(404)
  })

  it('POST refuses a caller outside the automation account', async () => {
    const res = (await POST(postReq({ type: 'add_tag' }), {
      params,
    })) as unknown as { status: number }
    expect(res.status).toBe(404)
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.recompiles).toHaveLength(0)
  })

  it('POST inserts into the owning account and recompiles steps', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(
      postReq({ type: 'add_tag', config: { tag_id: 't1' }, position_x: 10, position_y: 20 }),
      { params },
    )) as unknown as { status: number; body: { node: Record<string, unknown> } }
    expect(res.status).toBe(201)
    expect(h.state.inserts[0]).toMatchObject({
      automation_id: 'auto-1',
      account_id: 'acc-old',
      type: 'add_tag',
      config: { tag_id: 't1' },
      position_x: 10,
      position_y: 20,
    })
    expect(h.state.recompiles).toContain('auto-1')
  })

  it('POST rejects an unknown node type before writing', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(postReq({ type: 'not_a_type' }), {
      params,
    })) as unknown as { status: number }
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('POST rejects a non-object config', async () => {
    h.state.callerAccountId = 'acc-old'
    const res = (await POST(postReq({ type: 'add_tag', config: [1, 2] }), {
      params,
    })) as unknown as { status: number }
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })
})
