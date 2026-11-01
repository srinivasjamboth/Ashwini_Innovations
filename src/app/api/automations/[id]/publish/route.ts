import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getAutomationForAccount,
  loadGraph,
  persistGraphAndSteps,
} from '@/lib/automations/graph-store'
import {
  collectPublishIssues,
  splitPublishIssues,
  type PublishIssue,
} from '@/lib/automations/publish-validation'

// ------------------------------------------------------------
// POST /api/automations/[id]/publish
//
// The dedicated "Publish Flow" gate. Unlike the Active toggle (which
// only refuses on blocking errors), publish runs the FULL validation,
// re-checks every live external dependency, and returns a structured
// {errors, warnings} breakdown so the UI can list exactly which node
// needs attention and let the user acknowledge non-blocking warnings
// before committing.
//
//   Body: { confirmWarnings?: boolean }
//
// Outcomes:
//   * blocking errors present        -> 422 { ok:false, errors, warnings }
//   * only warnings, not confirmed   -> 200 { ok:false, needsConfirmation,
//                                             errors:[], warnings }
//   * clean (or warnings confirmed)  -> sets is_active=true, recompiles
//                                       steps -> 200 { ok:true, flow,
//                                       errors, warnings }
//
// Live re-checks (a node config is authored once, but the referenced
// resource can change afterwards):
//   * every Template node's template must still be status APPROVED on
//     this account;
//   * every WhatsApp Form node's form must still be status published
//     (with a Meta flow id) on this account.
// Missing either is a BLOCKING error at publish time.
// ------------------------------------------------------------

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Publishing flips the automation active — same write floor as the
  // Active toggle / node edits (the service-role client bypasses RLS).
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as
    | { confirmWarnings?: boolean }
    | null
  const confirmWarnings = body?.confirmWarnings === true

  const admin = supabaseAdmin()

  const parent = await getAutomationForAccount(id, accountId)
  if (!parent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // getAutomationForAccount only confirms tenancy + is_active; the
  // trigger lives on the same row but needs its own read.
  const { data: meta } = await admin
    .from('automations')
    .select('trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()

  const { nodes, edges } = await loadGraph(id)

  // Full publish gate — static validation (trigger + whole graph) plus
  // the live template/form re-checks, shared with the create-and-publish
  // path so the two entry points can never disagree about what is
  // publishable. A DB read failure inside the gate is a 500.
  let allIssues: PublishIssue[]
  try {
    allIssues = await collectPublishIssues({
      admin,
      accountId,
      triggerType: meta?.trigger_type,
      triggerConfig: meta?.trigger_config,
      nodes,
      edges,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'validation failed' },
      { status: 500 },
    )
  }
  const { errors, warnings } = splitPublishIssues(allIssues)

  // 1. Genuinely broken graph — never publish.
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: 'Fix the errors below before publishing', errors, warnings },
      { status: 422 },
    )
  }

  // 2. Advisory-only, not yet acknowledged — ask the user to confirm.
  if (warnings.length > 0 && !confirmWarnings) {
    return NextResponse.json({
      ok: false,
      needsConfirmation: true,
      errors: [],
      warnings,
    })
  }

  // 3. Publish. Ensure the compiled step tree mirrors the graph, then
  //    flip active in one shot so the engine picks up exactly what was
  //    validated.
  const recompErr = await persistGraphAndSteps(id)
  if (recompErr) {
    return NextResponse.json({ error: recompErr }, { status: 500 })
  }

  const { data: updated, error: updErr } = await admin
    .from('automations')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, flow: updated, errors: [], warnings })
}
