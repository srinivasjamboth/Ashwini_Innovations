import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getAutomationForAccount,
  loadGraph,
  persistGraphAndSteps,
} from '@/lib/automations/graph-store'
import { validateGraphConfig, blockingOnly } from '@/lib/automations/graph'

// ------------------------------------------------------------
// /api/automations/[id]/nodes/[nodeId] — single canvas node.
// PATCH carries config edits (debounced from the config panel) and
// drag-position writes (onNodeDragStop). DELETE cascades the node's
// edges via the FK. Both recompile the steps tree.
// Tenancy: service-role client bypasses RLS → match the parent on
// account_id AND the node on account_id (GHSA-xvrq-88hg-44q6).
// ------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id, nodeId } = await params

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

  const update: Record<string, unknown> = {}
  if ('config' in body) {
    if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
      return NextResponse.json({ error: 'config must be an object' }, { status: 400 })
    }
    update.config = body.config
  }
  if ('position_x' in body) {
    const x = Number(body.position_x)
    if (!Number.isFinite(x)) return NextResponse.json({ error: 'position_x must be a number' }, { status: 400 })
    update.position_x = x
  }
  if ('position_y' in body) {
    const y = Number(body.position_y)
    if (!Number.isFinite(y)) return NextResponse.json({ error: 'position_y must be a number' }, { status: 400 })
    update.position_y = y
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no updatable fields in body' }, { status: 400 })
  }

  // Editing an ACTIVE automation may not leave it un-executable: run
  // the prospective graph through the activation gate first and
  // reject with the itemized issues (same {error, issues} shape the
  // builder toast understands). Position-only writes don't change
  // execution semantics, so only config edits are gated.
  if (parent.is_active && 'config' in update) {
    const { nodes, edges } = await loadGraph(id)
    const prospective = nodes.map((n) =>
      n.id === nodeId ? { ...n, config: update.config as Record<string, unknown> } : n,
    )
    const issues = blockingOnly(validateGraphConfig(prospective, edges))
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot edit an active automation into an invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const admin = supabaseAdmin()
  const { data: node, error } = await admin
    .from('automation_nodes')
    .update(update)
    .eq('id', nodeId)
    .eq('automation_id', id)
    .eq('account_id', accountId)
    .select()
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!node) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Pure position drags don't change execution semantics, but the
  // tree rows carry no positions either — only recompile when the
  // config actually changed to keep drag-write cheap.
  if ('config' in update) {
    const recompErr = await persistGraphAndSteps(id)
    if (recompErr) return NextResponse.json({ error: recompErr }, { status: 500 })
  }

  return NextResponse.json({ node })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id, nodeId } = await params

  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const parent = await getAutomationForAccount(id, accountId)
  if (!parent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Node deletion cascades its edges (FK) and drops the step from
  // the compiled tree — gate it for active automations the same way
  // as config edits: successors would become unreachable.
  if (parent.is_active) {
    const { nodes, edges } = await loadGraph(id)
    const issues = blockingOnly(
      validateGraphConfig(
        nodes.filter((n) => n.id !== nodeId),
        edges.filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId),
      ),
    )
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot delete a node while the automation would be left invalid', issues },
        { status: 400 },
      )
    }
  }

  const admin = supabaseAdmin()
  // Edges referencing this node cascade via the FK
  // (source_node_id / target_node_id ON DELETE CASCADE), matching the
  // canvas contract that deleting a node deletes its connections.
  const { error } = await admin
    .from('automation_nodes')
    .delete()
    .eq('id', nodeId)
    .eq('automation_id', id)
    .eq('account_id', accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const recompErr = await persistGraphAndSteps(id)
  if (recompErr) return NextResponse.json({ error: recompErr }, { status: 500 })

  return NextResponse.json({ ok: true })
}
