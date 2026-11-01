import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getAutomationForAccount,
  loadGraph,
  persistGraphAndSteps,
} from '@/lib/automations/graph-store'
import { validateGraphConfig } from '@/lib/automations/graph'

// ------------------------------------------------------------
// /api/automations/[id]/edges/[edgeId] — disconnect two nodes.
// Backs both the hover "×" affordance and selection + Delete on the
// canvas. Deleting a connection from an ACTIVE automation goes
// through the same itemized activation gate — a cut that would leave
// a condition half-wired is rejected with the exact issue instead of
// silently breaking a live automation.
// ------------------------------------------------------------

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; edgeId: string }> },
) {
  const { id, edgeId } = await params

  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const parent = await getAutomationForAccount(id, accountId)
  if (!parent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('automation_edges')
    .select('id')
    .eq('id', edgeId)
    .eq('automation_id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (parent.is_active) {
    const { nodes, edges } = await loadGraph(id)
    const issues = validateGraphConfig(nodes, edges.filter((e) => e.id !== edgeId))
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot disconnect while the automation is active with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const { error } = await admin
    .from('automation_edges')
    .delete()
    .eq('id', edgeId)
    .eq('automation_id', id)
    .eq('account_id', accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const recompErr = await persistGraphAndSteps(id)
  if (recompErr) return NextResponse.json({ error: recompErr }, { status: 500 })

  return NextResponse.json({ ok: true })
}
