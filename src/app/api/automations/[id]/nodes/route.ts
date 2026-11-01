import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getAutomationForAccount,
  loadGraph,
  persistGraphAndSteps,
} from '@/lib/automations/graph-store'
import { isAutomationNodeType } from '@/lib/automations/graph-types'

// ------------------------------------------------------------
// /api/automations/[id]/nodes — canvas node collection.
//
// Tenancy (GHSA-xvrq-88hg-44q6, same note as ../route.ts): every
// handler runs on the service-role client, which bypasses RLS, so
// the parent automation MUST be matched on `account_id` — never
// `user_id` — before any graph row is read or written. Writes
// require `agent`; reads are open to any member.
//
// Every mutation recompiles the automation_steps tree
// (persistGraphAndSteps) so the execution engine keeps running the
// authored graph with zero changes to its own data contract.
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

  const { nodes, edges } = await loadGraph(id)
  return NextResponse.json({ nodes, edges })
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

  if (!(await getAutomationForAccount(id, accountId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { type, config, position_x, position_y } = body
  if (!isAutomationNodeType(type)) {
    return NextResponse.json({ error: `unknown node type: ${String(type)}` }, { status: 400 })
  }
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    return NextResponse.json({ error: 'config must be an object' }, { status: 400 })
  }
  // Drafts are intentionally lenient: required-field strictness lives
  // in the activation gate (validateGraphConfig), matching how step
  // configs behave in the vertical builder.

  const admin = supabaseAdmin()
  const { data: node, error } = await admin
    .from('automation_nodes')
    .insert({
      automation_id: id,
      account_id: accountId,
      type,
      config: config ?? {},
      position_x: Number(position_x ?? 0),
      position_y: Number(position_y ?? 0),
    })
    .select()
    .single()

  if (error || !node) {
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })
  }

  const recompErr = await persistGraphAndSteps(id)
  if (recompErr) return NextResponse.json({ error: recompErr }, { status: 500 })

  return NextResponse.json({ node }, { status: 201 })
}
