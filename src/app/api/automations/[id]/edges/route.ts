import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getAutomationForAccount,
  loadGraph,
  persistGraphAndSteps,
} from '@/lib/automations/graph-store'
import { validateGraphConfig, wouldCreateCycle } from '@/lib/automations/graph'
import type { AutomationEdgeRow } from '@/lib/automations/graph-types'

// ------------------------------------------------------------
// /api/automations/[id]/edges — canvas connections.
//
// Same tenancy contract as ./nodes: service-role client, parent
// matched on account_id, writes gated on `agent` (RLS is bypassed
// here, so the role check is the enforcement point).
//
// POST mirrors the canvas invariants (validated eagerly so users get
// immediate feedback instead of a publish-time surprise):
//   • both endpoints belong to this automation;
//   • no self-loops, no cycles;
//   • a target may only have one incoming connection (the compiled
//     steps model has no join semantics);
//   • starting_step can only be a source;
//   • condition sources must carry 'yes'/'no'; every other source
//     must be plain (NULL).
// ------------------------------------------------------------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  if (!(await getAutomationForAccount(id, accountId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { edges } = await loadGraph(id)
  return NextResponse.json({ edges })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const parent = await getAutomationForAccount(id, accountId)
  if (!parent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { source_node_id, target_node_id } = body
  const handle = body.source_handle ?? null
  if (typeof source_node_id !== 'string' || typeof target_node_id !== 'string') {
    return NextResponse.json({ error: 'source_node_id and target_node_id are required' }, { status: 400 })
  }
  if (handle !== null && handle !== 'yes' && handle !== 'no') {
    return NextResponse.json({ error: 'source_handle must be "yes", "no", or null' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const { data: source } = await admin
    .from('automation_nodes')
    .select('id, type')
    .eq('id', source_node_id)
    .eq('automation_id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  const { data: target } = await admin
    .from('automation_nodes')
    .select('id, type')
    .eq('id', target_node_id)
    .eq('automation_id', id)
    .eq('account_id', accountId)
    .maybeSingle()

  if (!source || !target) {
    return NextResponse.json({ error: 'source and target must be nodes of this automation' }, { status: 400 })
  }
  if (source_node_id === target_node_id) {
    return NextResponse.json({ error: 'a node cannot connect to itself' }, { status: 400 })
  }
  if (target.type === 'starting_step') {
    return NextResponse.json({ error: 'the starting step cannot have an incoming connection' }, { status: 400 })
  }
  if (source.type === 'condition' && handle === null) {
    return NextResponse.json({ error: 'condition connections must be marked Yes or No' }, { status: 400 })
  }
  if (source.type !== 'condition' && handle !== null) {
    return NextResponse.json({ error: `only condition nodes can use "${handle}" output handles` }, { status: 400 })
  }

  const { nodes, edges } = await loadGraph(id)

  const { data: incoming } = await admin
    .from('automation_edges')
    .select('id')
    .eq('automation_id', id)
    .eq('target_node_id', target_node_id)
    .limit(1)
  if ((incoming ?? []).length > 0) {
    return NextResponse.json({ error: 'that step already has an incoming connection' }, { status: 400 })
  }
  if (wouldCreateCycle(edges, source_node_id, target_node_id)) {
    return NextResponse.json({ error: 'that connection would create a loop' }, { status: 400 })
  }

  // Editing an ACTIVE automation may not leave it un-executable —
  // reject with the itemized issues, same {error, issues} shape the
  // builder toast already understands.
  if (parent.is_active) {
    const prospective: AutomationEdgeRow[] = [
      ...edges,
      {
        id: 'prospective',
        automation_id: id,
        account_id: accountId,
        source_node_id,
        target_node_id,
        source_handle: handle,
      },
    ]
    const issues = validateGraphConfig(nodes, prospective)
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot connect while the automation is active with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const { data: edge, error } = await admin
    .from('automation_edges')
    .insert({
      automation_id: id,
      account_id: accountId,
      source_node_id,
      target_node_id,
      source_handle: handle,
    })
    .select()
    .single()

  if (error || !edge) {
    // 23505 = the unique (source, target, handle) index — duplicate
    // connection, surface it plainly rather than as a 500.
    if (error?.code === '23505') {
      return NextResponse.json({ error: 'those nodes are already connected' }, { status: 400 })
    }
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })
  }

  const recompErr = await persistGraphAndSteps(id)
  if (recompErr) return NextResponse.json({ error: recompErr }, { status: 500 })

  return NextResponse.json({ edge }, { status: 201 })
}
