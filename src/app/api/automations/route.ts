import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkLimit } from '@/lib/plans/entitlements'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import { blockingOnly, compileGraphToSteps, validateGraphConfig } from '@/lib/automations/graph'
import { insertGraph } from '@/lib/automations/graph-store'
import type { AutomationEdgeRow, AutomationNodeRow } from '@/lib/automations/graph-types'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import {
  collectPublishIssues,
  splitPublishIssues,
} from '@/lib/automations/publish-validation'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ automations: data ?? [] })
}

export async function POST(request: Request) {
  // Creating an automation is a write — the RLS automations_insert policy
  // requires `agent`, but this route inserts via the service-role client
  // which bypasses RLS, so the role must be enforced here.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Resolve the caller's account_id — `automations.account_id` is NOT
  // NULL post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { name, description, trigger_type, trigger_config, is_active, steps, template, graph, publish, confirmWarnings } = body

  // Canvas create path: the graph draft is authoritative — it is
  // persisted to automation_nodes/edges and compiled down to the
  // automation_steps tree the engine runs. `steps` stays supported
  // for the legacy template-seed + vertical-builder payloads.
  const graphDraft: { nodes: AutomationNodeRow[]; edges: AutomationEdgeRow[] } | null =
    graph && Array.isArray(graph.nodes) && graph.nodes.length > 0
      ? {
          nodes: graph.nodes as AutomationNodeRow[],
          // Synthetic monotonic created_at preserves the authored
          // sibling order (insertGraph applies the same clock below).
          edges: (Array.isArray(graph.edges) ? graph.edges : []).map(
            (e: AutomationEdgeRow, i: number) => ({
              ...e,
              created_at: new Date(Date.now() + i).toISOString(),
            }),
          ),
        }
      : null

  let effectiveSteps: BuilderStepInput[] | undefined = steps
  let effectiveName = name
  let effectiveDescription = description
  let effectiveTriggerType = trigger_type
  let effectiveTriggerConfig = trigger_config

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template)
    if (t) {
      effectiveName = effectiveName ?? t.name
      effectiveDescription = effectiveDescription ?? t.description
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
      effectiveSteps = t.steps as unknown as BuilderStepInput[]
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'name and trigger_type are required' },
      { status: 400 },
    )
  }

  // Plan enforcement (Part 4): automation flows are a counted resource.
  const limit = await checkLimit(accountId, 'automation_flows')
  if (!limit.allowed) return NextResponse.json(limit, { status: 403 })

  const admin = supabaseAdmin()
  const wantsPublish = publish === true

  // Create-and-publish — the new-automation Publish button. Validate the
  // in-memory graph through the SAME gate the standalone publish route
  // uses, and only write the row once it is publishable. Errors or
  // unacknowledged warnings return WITHOUT creating anything, so a failed
  // Publish never leaves an orphan draft and a retry can't duplicate the
  // automation. The client sends the graph authoritatively, so publishing
  // a brand-new flow is a single round-trip.
  if (wantsPublish) {
    if (!graphDraft) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Add at least one step before publishing',
          errors: [
            { path: 'graph', message: 'Add at least one step before publishing', severity: 'error' },
          ],
          warnings: [],
        },
        { status: 422 },
      )
    }
    let issues
    try {
      issues = await collectPublishIssues({
        admin,
        accountId,
        triggerType: effectiveTriggerType,
        triggerConfig: effectiveTriggerConfig ?? {},
        nodes: graphDraft.nodes,
        edges: graphDraft.edges,
      })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'validation failed' },
        { status: 500 },
      )
    }
    const { errors, warnings } = splitPublishIssues(issues)
    if (errors.length > 0) {
      return NextResponse.json(
        { ok: false, error: 'Fix the errors below before publishing', errors, warnings },
        { status: 422 },
      )
    }
    if (warnings.length > 0 && confirmWarnings !== true) {
      return NextResponse.json({
        ok: false,
        needsConfirmation: true,
        errors: [],
        warnings,
      })
    }
  } else if (is_active) {
    // Plain activation (Active toggle / save-as-active): the lighter
    // static-only gate. Drafts (is_active=false) stay allowed to be
    // incomplete so users can save progress mid-build.
    const issues = blockingOnly([
      ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
      ...(graphDraft
        ? validateGraphConfig(graphDraft.nodes, graphDraft.edges)
        : validateStepsForActivation(
            (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
          )),
    ])
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot activate automation with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const { data: automation, error: insertErr } = await admin
    .from('automations')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: effectiveName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      is_active: wantsPublish ? true : !!is_active,
    })
    .select()
    .single()

  if (insertErr || !automation) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'insert failed' },
      { status: 500 },
    )
  }

  if (graphDraft) {
    const graphErr = await insertGraph(automation.id, accountId, {
      nodes: graphDraft.nodes,
      edges: graphDraft.edges,
    })
    if (graphErr) return NextResponse.json({ error: graphErr }, { status: 500 })
    const err = await insertSteps(automation.id, compileGraphToSteps(graphDraft.nodes, graphDraft.edges))
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  } else if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.id, effectiveSteps)
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  if (wantsPublish) {
    return NextResponse.json({ ok: true, automation, errors: [], warnings: [] }, { status: 201 })
  }
  return NextResponse.json({ automation }, { status: 201 })
}
