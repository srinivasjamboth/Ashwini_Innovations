import { supabaseAdmin } from './admin-client'
import { compileGraphToSteps, decompileStepsToGraph } from './graph'
import { replaceSteps } from './steps-tree'
import { isAutomationNodeType, type AutomationEdgeRow, type AutomationNodeRow } from './graph-types'

// ------------------------------------------------------------
// Persistence helpers for the automation canvas graph.
//
// The graph (automation_nodes / automation_edges) is the authoring
// source of truth; every mutation funnels through
// `persistGraphAndSteps`, which recompiles the `automation_steps`
// tree the execution engine runs. Service-role client + explicit
// account_id scoping at the route layer (mirrors the tenancy note
// in api/automations/[id]/route.ts / GHSA-xvrq-88hg-44q6).
// ------------------------------------------------------------

/**
 * Fetch the parent automation matched on `account_id` — the tenancy
 * column (never `user_id`, see GHSA-xvrq-88hg-44q6). Returns null
 * when the automation is missing or belongs to another account, so
 * every nodes/edges handler gates on it before touching graph rows.
 */
export async function getAutomationForAccount(
  automationId: string,
  accountId: string,
): Promise<{ id: string; account_id: string; is_active: boolean } | null> {
  const { data } = await supabaseAdmin()
    .from('automations')
    .select('id, account_id, is_active')
    .eq('id', automationId)
    .eq('account_id', accountId)
    .maybeSingle()
  return data as { id: string; account_id: string; is_active: boolean } | null
}

export async function loadGraph(automationId: string): Promise<{
  nodes: AutomationNodeRow[]
  edges: AutomationEdgeRow[]
}> {
  const admin = supabaseAdmin()
  const [{ data: nodes }, { data: edges }] = await Promise.all([
    admin
      .from('automation_nodes')
      .select('*')
      .eq('automation_id', automationId)
      .order('created_at', { ascending: true }),
    admin
      .from('automation_edges')
      .select('*')
      .eq('automation_id', automationId)
      .order('created_at', { ascending: true }),
  ])
  return {
    nodes: (nodes ?? []) as AutomationNodeRow[],
    edges: (edges ?? []) as AutomationEdgeRow[],
  }
}

/**
 * Graph rows for GET /api/automations/[id]. Pre-canvas automations
 * have no rows yet, so fall back to decompiling their steps tree —
 * the 055 migration does the same, this keeps the canvas working even
 * against a database where the data migration hasn't been replayed.
 */
export async function loadGraphOrDecompile(
  automationId: string,
  steps: unknown[],
): Promise<{ nodes: AutomationNodeRow[]; edges: AutomationEdgeRow[] }> {
  const graph = await loadGraph(automationId)
  if (graph.nodes.length > 0) return graph
  return decompileStepsToGraph(
    steps as Parameters<typeof decompileStepsToGraph>[0],
  )
}

/** Recompile the steps tree from the stored graph. Returns an error
 *  message (null = success). */
export async function persistGraphAndSteps(automationId: string): Promise<string | null> {
  const { nodes, edges } = await loadGraph(automationId)
  return replaceSteps(automationId, compileGraphToSteps(nodes, edges))
}

/**
 * Insert a whole draft graph (create path: POST /api/automations with
 * `graph`). Edge created_at gets a monotonic synthetic clock so the
 * sibling order the client authored survives the compile — parallel
 * INSERTs would otherwise share one NOW().
 */
export async function insertGraph(
  automationId: string,
  accountId: string,
  draft: { nodes: unknown[]; edges: unknown[] },
): Promise<string | null> {
  const nodes = draft.nodes as Partial<AutomationNodeRow>[]
  const edges = draft.edges as Partial<AutomationEdgeRow>[]

  const nodeIds = new Set<string>()
  for (const n of nodes) {
    if (!n?.id || typeof n.id !== 'string') return 'node id is required'
    if (!isAutomationNodeType(n.type)) return `unknown node type: ${String(n.type)}`
    nodeIds.add(n.id)
  }
  for (const e of edges) {
    if (!e?.id || !e.source_node_id || !e.target_node_id) return 'edge source and target are required'
    if (!nodeIds.has(e.source_node_id) || !nodeIds.has(e.target_node_id)) {
      return 'edge references a node that is not in the graph'
    }
  }

  const admin = supabaseAdmin()
  const { error: nodeErr } = await admin.from('automation_nodes').insert(
    nodes.map((n) => ({
      id: n.id,
      automation_id: automationId,
      account_id: accountId,
      type: n.type,
      config: n.config ?? {},
      position_x: Number(n.position_x ?? 0),
      position_y: Number(n.position_y ?? 0),
    })),
  )
  if (nodeErr) return nodeErr.message

  if (edges.length > 0) {
    const base = Date.now()
    const { error: edgeErr } = await admin.from('automation_edges').insert(
      edges.map((e, i) => ({
        id: e.id,
        automation_id: automationId,
        account_id: accountId,
        source_node_id: e.source_node_id,
        target_node_id: e.target_node_id,
        source_handle: e.source_handle ?? null,
        // Monotonic synthetic clock: preserves the authored sibling
        // order even when every row would share one NOW().
        created_at: new Date(base + i).toISOString(),
      })),
    )
    if (edgeErr) return edgeErr.message
  }
  return null
}
