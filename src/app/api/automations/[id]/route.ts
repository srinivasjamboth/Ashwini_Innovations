import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import { loadGraph, loadGraphOrDecompile } from '@/lib/automations/graph-store'
import { blockingOnly, validateGraphConfig } from '@/lib/automations/graph'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

// ------------------------------------------------------------
// Tenancy note (GHSA-xvrq-88hg-44q6)
//
// Every handler here reads/writes through the service-role client,
// which bypasses the account-scoped `automations_*` RLS policies. So
// the row has to be matched on `account_id` — the tenancy column
// migration 017 introduced — and NOT on `user_id`, which records the
// original *author* and is never rewritten.
//
// `user_id` is not an authorization fact: `remove_account_member`
// (migration 018) moves a removed member into a fresh personal account
// as its `owner`, which clears `requireRole('agent')` trivially while
// leaving `automations.user_id` pointing at them. Matching on it let an
// ex-member keep full CRUD over automations they had authored inside
// the account they were removed from.
// ------------------------------------------------------------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Reading is open to any member (`automations_select` has no role
  // floor) but is still account-scoped.
  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const steps = await loadStepsTree(id)
  // Canvas graph rows. Automations authored before the graph builder
  // have no rows yet — decompile their step tree on read so the
  // canvas can open any automation (migration 055 backfills the
  // tables; this keeps working either way).
  const graph = await loadGraphOrDecompile(id, steps)
  return NextResponse.json({ automation, steps, nodes: graph.nodes, edges: graph.edges })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Editing an automation is a write — the RLS automations_update policy
  // requires `agent`, but this route mutates via the service-role client
  // which bypasses RLS, so enforce the role here.
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const admin = supabaseAdmin()

  // Tenancy check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select('id, account_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k]
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  //
  // Graph-authored automations validate the NODE/EDGE graph (per-node
  // required config + both condition handles wired + structural
  // integrity) — itemized per node. The compiled step tree is a
  // build artifact there, so a legacy `steps` body is ignored once a
  // graph exists; pre-canvas automations keep the old step-tree gate.
  // (Raw table read — no decompile fallback here, so a legacy
  // automation with an empty graph table still takes the steps path.)
  const { nodes: graphNodes, edges: graphEdges } = await loadGraph(id)
  const willBeActive =
    typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
    const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
    if (graphNodes.length > 0) {
      const issues = blockingOnly([
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateGraphConfig(graphNodes, graphEdges),
      ])
      if (issues.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot keep automation active with invalid configuration',
            issues,
          },
          { status: 400 },
        )
      }
    } else {
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id)
      const issues = blockingOnly([
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(mergedSteps),
      ])
      if (issues.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot keep automation active with invalid configuration',
            issues,
          },
          { status: 400 },
        )
      }
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  if (Array.isArray(body.steps) && graphNodes.length === 0) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[])
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Deleting an automation is a write — enforce `agent` (the service-role
  // client below bypasses the agent-gated automations_delete RLS).
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
