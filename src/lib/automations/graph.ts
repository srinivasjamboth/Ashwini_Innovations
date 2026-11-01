import type { BuilderStepInput } from './steps-tree'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { validateLegacyStepConfig, type IssueSeverity } from './validate'
import {
  isAutomationNodeType,
  type AutomationEdgeRow,
  type AutomationNodeRow,
  type AutomationNodeType,
} from './graph-types'

// ------------------------------------------------------------
// Automation graph ↔ steps-tree bridge.
//
// The canvas authors a node/edge graph; the execution engine runs
// the `automation_steps` tree (sequential siblings + condition
// yes/no branches). These pure functions are the only translation
// layer, so the engine, cron, pending executions and logs keep
// working with zero changes to their data contract.
//
// Shape rules the graph must obey to be tree-compileable:
//   • exactly one `starting_step` (the trigger); it compiles away —
//     its children become the root scope;
//   • every other node has at most ONE incoming edge (the steps
//     model has no join/diamond semantics);
//   • acyclic;
//   • `condition` nodes route through named handles ('yes'/'no'),
//     everything else uses plain (NULL) handles.
//
// Multiple plain edges out of a non-condition node compile to
// SEQUENTIAL siblings in edge-creation order (documented semantics —
// the engine's tree is sequential per scope).
// ------------------------------------------------------------

// ----------------------------------------------------------
// compile: graph → steps tree
// ----------------------------------------------------------

export function compileGraphToSteps(
  nodes: AutomationNodeRow[],
  edges: AutomationEdgeRow[],
): BuilderStepInput[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, AutomationEdgeRow[]>()
  for (const e of [...edges].sort(compareEdges)) {
    const bucket = out.get(e.source_node_id)
    if (bucket) bucket.push(e)
    else out.set(e.source_node_id, [e])
  }

  const visited = new Set<string>()
  const roots: BuilderStepInput[] = []

  // starting_step compiles away: its children are the root scope.
  for (const start of nodes.filter((n) => n.type === 'starting_step')) {
    visited.add(start.id)
    roots.push(...chainPlain(start.id))
  }
  return roots

  function chainPlain(nodeId: string): BuilderStepInput[] {
    const arr: BuilderStepInput[] = []
    for (const e of out.get(nodeId) ?? []) appendTarget(e.target_node_id, arr)
    return arr
  }

  function chainBucket(nodeId: string, handle: 'yes' | 'no'): BuilderStepInput[] {
    const arr: BuilderStepInput[] = []
    for (const e of out.get(nodeId) ?? []) {
      if (e.source_handle === handle) appendTarget(e.target_node_id, arr)
    }
    return arr
  }

  function appendTarget(targetId: string, arr: BuilderStepInput[]) {
    const t = byId.get(targetId)
    // Cycles / duplicate targets / stray starting nodes: skipped here,
    // reported by validateGraphConfig at activation.
    if (!t || visited.has(t.id) || t.type === 'starting_step') return
    visited.add(t.id)

    if (t.type === 'condition') {
      arr.push({
        step_type: 'condition',
        step_config: t.config,
        branches: {
          yes: chainBucket(t.id, 'yes'),
          no: chainBucket(t.id, 'no'),
        },
      })
      return
    }
    arr.push(toStep(t))
    // Non-condition continuations are siblings, depth-first.
    arr.push(...chainPlain(t.id))
  }
}

function compareEdges(a: AutomationEdgeRow, b: AutomationEdgeRow): number {
  const ta = a.created_at ?? ''
  const tb = b.created_at ?? ''
  if (ta !== tb) return ta < tb ? -1 : 1
  return (a.id ?? '') < (b.id ?? '') ? -1 : 1
}

/** Palette node → engine step. Legacy node types pass through 1:1. */
function toStep(node: AutomationNodeRow): BuilderStepInput {
  const c = node.config ?? {}
  switch (node.type) {
    // ---- Messages palette ----
    case 'text_button':
      return { step_type: 'send_buttons', step_config: c }
    case 'media':
      return {
        step_type: 'send_media',
        step_config: {
          kind: c.media_kind ?? 'image',
          link: c.url,
          ...(typeof c.caption === 'string' && c.caption ? { caption: c.caption } : {}),
          ...(typeof c.filename === 'string' && c.filename ? { filename: c.filename } : {}),
        },
      }
    case 'audio':
      return { step_type: 'send_media', step_config: { kind: 'audio', link: c.url } }
    case 'list':
      return { step_type: 'send_list', step_config: c }
    case 'template':
      return { step_type: 'send_template', step_config: c }
    case 'ask_question':
      return { step_type: 'capture_reply', step_config: { text: c.text ?? '', variable: c.variable ?? '' } }
    case 'whatsapp_form':
      return { step_type: 'send_flow', step_config: { flow_id: c.flow_id ?? '' } }
    case 'payment':
      return { step_type: 'send_message', step_config: { text: paymentText(c) } }
    // ---- Actions palette ----
    case 'save_attribute':
      return { step_type: 'update_contact_field', step_config: { field: c.field ?? '', value: c.value ?? '' } }
    case 'add_tag':
      return { step_type: 'add_tag', step_config: { tag_id: c.tag_id ?? '' } }
    case 'google_sheet':
      // No Sheets integration in the engine yet — runs as a logged skip.
      return { step_type: 'google_sheet', step_config: c }
    case 'meta_capi':
      return { step_type: 'meta_capi', step_config: c }
    case 'time_delay':
      return { step_type: 'wait', step_config: { amount: c.amount, unit: c.unit } }
    case 'webhook':
      return {
        step_type: 'send_webhook',
        step_config: {
          url: c.url ?? '',
          method: c.method ?? 'POST',
          ...(c.headers && typeof c.headers === 'object' ? { headers: c.headers } : {}),
          body_template: c.payload ?? '',
        },
      }
    case 'condition':
      // Handled by the caller (needs branches).
      return { step_type: 'condition', step_config: c }
    // ---- Legacy passthroughs ----
    case 'send_message':
    case 'send_buttons':
    case 'send_list':
    case 'send_template':
    case 'remove_tag':
    case 'assign_conversation':
    case 'update_contact_field':
    case 'create_deal':
    case 'wait':
    case 'send_webhook':
    case 'close_conversation':
      return { step_type: node.type, step_config: c }
    case 'starting_step':
      return { step_type: 'noop', step_config: {} }
    default:
      return { step_type: String(node.type), step_config: c }
  }
}

/** WhatsApp has no native payment primitive — the node compiles to a
 *  payment-request text message (amount/currency/description). */
export function paymentText(c: Record<string, unknown>): string {
  const raw = Number(c.amount)
  const amount = Number.isFinite(raw) ? raw.toFixed(2) : String(c.amount ?? '0')
  const currency = String(c.currency ?? '').trim().toUpperCase() || 'INR'
  const desc = typeof c.description === 'string' ? c.description.trim() : ''
  const head = `Payment required: ${currency} ${amount}`
  return desc ? `${head}\n\n${desc}` : head
}

// ----------------------------------------------------------
// decompile: steps tree → graph (legacy automations + GET fallback)
// ----------------------------------------------------------

export interface GraphDraft {
  nodes: AutomationNodeRow[]
  edges: AutomationEdgeRow[]
}

interface StepNodeLike {
  id?: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: {
    yes?: StepNodeLike[]
    no?: StepNodeLike[]
  }
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * Rebuild a canvas graph from a steps tree. Positions are a simple
 * vertical layout (240px per step, branches offset ±160px); users
 * can drag nodes afterwards and positions persist.
 */
export function decompileStepsToGraph(steps: StepNodeLike[]): GraphDraft {
  const nodes: AutomationNodeRow[] = []
  const edges: AutomationEdgeRow[] = []

  const startId = uid()
  nodes.push(mkNode(startId, 'starting_step', {}, 0, 0))

  walkList(steps, startId, 0, { y: 0 })
  return { nodes, edges }

  function walkList(list: StepNodeLike[], entrySourceId: string, x: number, cursor: { y: number }) {
    let prev = entrySourceId
    for (const s of list) {
      const y = cursor.y + 240
      cursor.y = y
      const { type, config } = toNodeType(s.step_type, s.step_config ?? {})
      const id = uid()
      nodes.push(mkNode(id, type, config, x, y))
      edges.push(mkEdge(prev, id, null))
      prev = id

      if (s.step_type === 'condition') {
        const yesArr = s.branches?.yes ?? []
        const noArr = s.branches?.no ?? []
        if (yesArr.length > 0) {
          const bc = { y }
          walkBucket(yesArr, id, x - 160, 'yes', bc)
          cursor.y = Math.max(cursor.y, bc.y)
        }
        if (noArr.length > 0) {
          const bc = { y }
          walkBucket(noArr, id, x + 160, 'no', bc)
          cursor.y = Math.max(cursor.y, bc.y)
        }
      }
    }
  }

  function walkBucket(list: StepNodeLike[], condId: string, x: number, handle: 'yes' | 'no', cursor: { y: number }) {
    let prev = condId
    let first = true
    for (const s of list) {
      const y = cursor.y + 240
      cursor.y = y
      const { type, config } = toNodeType(s.step_type, s.step_config ?? {})
      const id = uid()
      nodes.push(mkNode(id, type, config, x, y))
      edges.push(mkEdge(prev, id, first ? handle : null))
      first = false
      prev = id

      if (s.step_type === 'condition') {
        const yesArr = s.branches?.yes ?? []
        const noArr = s.branches?.no ?? []
        if (yesArr.length > 0) {
          const bc = { y }
          walkBucket(yesArr, id, x - 160, 'yes', bc)
          cursor.y = Math.max(cursor.y, bc.y)
        }
        if (noArr.length > 0) {
          const bc = { y }
          walkBucket(noArr, id, x + 160, 'no', bc)
          cursor.y = Math.max(cursor.y, bc.y)
        }
      }
    }
  }
}

/** Engine step_type → canvas node type (+ config translation back to
 *  the palette shape). Unknown types pass through so nothing is lost. */
function toNodeType(stepType: string, config: Record<string, unknown>): {
  type: AutomationNodeType
  config: Record<string, unknown>
} {
  switch (stepType) {
    case 'send_buttons':
      return { type: 'text_button', config }
    case 'send_list':
      return { type: 'list', config }
    case 'send_template':
      return { type: 'template', config }
    case 'send_media': {
      const kind = String(config.kind ?? 'image')
      const base = { url: String(config.link ?? ''), caption: String(config.caption ?? '') }
      if (kind === 'audio') return { type: 'audio', config: { url: base.url } }
      return {
        type: 'media',
        config: {
          media_kind: ['image', 'video', 'document'].includes(kind) ? kind : 'image',
          ...base,
          filename: String(config.filename ?? ''),
        },
      }
    }
    case 'capture_reply':
      return { type: 'ask_question', config: { text: config.text ?? '', variable: config.variable ?? '' } }
    case 'send_flow':
      return { type: 'whatsapp_form', config: { flow_id: config.flow_id ?? '' } }
    case 'update_contact_field':
      return { type: 'save_attribute', config: { field: config.field ?? '', value: config.value ?? '' } }
    case 'wait':
      return { type: 'time_delay', config: { amount: config.amount, unit: config.unit } }
    case 'send_webhook':
      return {
        type: 'webhook',
        config: {
          url: config.url ?? '',
          method: config.method ?? 'POST',
          headers: config.headers ?? {},
          payload: config.body_template ?? '',
        },
      }
    case 'condition':
    case 'add_tag':
    case 'remove_tag':
    case 'assign_conversation':
    case 'create_deal':
    case 'send_message':
    case 'close_conversation':
    case 'google_sheet':
    case 'meta_capi':
      return { type: stepType as AutomationNodeType, config }
    default:
      // Preserve anything unknown verbatim (isAutomationNodeType-guarded
      // at insert time; decompile is display-only fallback).
      return {
        type: (isAutomationNodeType(stepType) ? stepType : 'send_message') as AutomationNodeType,
        config,
      }
  }
}

function mkNode(
  id: string,
  type: AutomationNodeType,
  config: Record<string, unknown>,
  x: number,
  y: number,
): AutomationNodeRow {
  return { id, automation_id: '', account_id: '', type, config, position_x: x, position_y: y }
}

function mkEdge(source: string, target: string, handle: 'yes' | 'no' | null): AutomationEdgeRow {
  return { id: uid(), automation_id: '', account_id: '', source_node_id: source, target_node_id: target, source_handle: handle }
}

// ----------------------------------------------------------
// validation: per-node config + graph integrity (activation gate)
// ----------------------------------------------------------

export interface GraphValidationIssue {
  path: string
  message: string
  /** Undefined means a blocking error; 'warning' is non-blocking and
   *  only advisory (surfaced to the user, but never refuses publish). */
  severity?: IssueSeverity
}

/**
 * Filter an issue list down to the entries that must block activation /
 * publish. Warnings (unreachable drafts, a single unwired condition
 * branch, a zero-length delay) are advisory and drop out here so the
 * Active toggle, node-edit gate and publish gate stay non-blocking for
 * them while still refusing genuinely broken graphs.
 */
export function blockingOnly<T extends { severity?: IssueSeverity }>(
  issues: T[],
): T[] {
  return issues.filter((i) => i.severity !== 'warning')
}

/**
 * Full activation-gate check for a graph: structural integrity plus
 * every node's required config fields. Itemized per node so the UI
 * can surface "fix this exact thing" errors, mirroring the
 * {path,message} shape of validate.ts.
 */
export function validateGraphConfig(
  nodes: AutomationNodeRow[],
  edges: AutomationEdgeRow[],
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = []

  // ---- structural ----
  const starts = nodes.filter((n) => n.type === 'starting_step')
  if (starts.length !== 1) {
    issues.push({
      path: 'graph.starting_step',
      message: `automation needs exactly one starting step (found ${starts.length})`,
    })
  }
  if (nodes.filter((n) => n.type !== 'starting_step').length === 0) {
    issues.push({ path: 'graph.steps', message: 'active automations need at least one step' })
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const indeg = new Map<string, number>()
  for (const e of edges) {
    if (!byId.has(e.source_node_id) || !byId.has(e.target_node_id)) {
      issues.push({ path: `edges.${e.id}`, message: 'edge references a node that is not in this automation' })
      continue
    }
    if (e.source_node_id === e.target_node_id) {
      issues.push({ path: `edges.${e.id}`, message: 'a node cannot connect to itself' })
    }
    indeg.set(e.target_node_id, (indeg.get(e.target_node_id) ?? 0) + 1)
    const src = byId.get(e.source_node_id)!
    if (e.source_handle !== null && src.type !== 'condition') {
      issues.push({
        path: `nodes.${src.id}`,
        message: `only condition nodes can use "${e.source_handle}" output handles`,
      })
    }
    if (e.source_handle === null && src.type === 'condition') {
      issues.push({
        path: `nodes.${src.id}`,
        message: 'condition branches must be marked Yes or No',
      })
    }
  }
  for (const [id, count] of indeg) {
    if (count > 1) {
      issues.push({
        path: `nodes.${id}`,
        message: 'a step cannot have more than one incoming connection',
      })
    }
  }

  // Reachability + cycle detection from the starting node.
  const out = new Map<string, AutomationEdgeRow[]>()
  for (const e of edges) {
    const b = out.get(e.source_node_id)
    if (b) b.push(e)
    else out.set(e.source_node_id, [e])
  }
  const reachable = new Set<string>()
  if (starts.length === 1) {
    const gray = new Set<string>()
    let cyclic = false
    const dfs = (id: string) => {
      reachable.add(id)
      gray.add(id)
      for (const e of out.get(id) ?? []) {
        if (gray.has(e.target_node_id)) cyclic = true
        else if (!reachable.has(e.target_node_id)) dfs(e.target_node_id)
      }
      gray.delete(id)
    }
    dfs(starts[0].id)
    if (cyclic) issues.push({ path: 'graph.cycle', message: 'the automation contains a loop' })
  }
  for (const n of nodes) {
    if (n.type !== 'starting_step' && !reachable.has(n.id)) {
      // Non-blocking: an orphan draft isn't necessarily an error, but
      // the user should know the node can't be reached when it fires.
      issues.push({
        path: `nodes.${n.id}`,
        message: `"${n.type}" is unreachable from the starting step`,
        severity: 'warning',
      })
    }
  }

  // Condition routing handles. Both unwired is a hard error (the step
  // goes nowhere); exactly one unwired is an advisory warning — that
  // branch just dead-ends, which the author may intend.
  for (const n of nodes.filter((x) => x.type === 'condition')) {
    const has = new Set((out.get(n.id) ?? []).map((e) => e.source_handle))
    const missingYes = !has.has('yes')
    const missingNo = !has.has('no')
    if (missingYes && missingNo) {
      issues.push({
        path: `nodes.${n.id}`,
        message: 'condition node has no branches connected',
      })
    } else {
      if (missingYes) {
        issues.push({
          path: `nodes.${n.id}.yes`,
          message: 'condition "Yes" branch is not connected — that path ends here',
          severity: 'warning',
        })
      }
      if (missingNo) {
        issues.push({
          path: `nodes.${n.id}.no`,
          message: 'condition "No" branch is not connected — that path ends here',
          severity: 'warning',
        })
      }
    }
  }

  // ---- per-node config ----
  for (const n of nodes) {
    validateOneNode(n, `nodes.${n.id}`, issues)
  }
  return issues
}

function validateOneNode(n: AutomationNodeRow, path: string, issues: GraphValidationIssue[]) {
  const c = n.config ?? {}
  switch (n.type) {
    case 'starting_step':
      return
    case 'text_button': {
      const r = validateInteractivePayload(c as never)
      if (!r.ok) issues.push({ path: `${path}.interactive`, message: r.error })
      return
    }
    case 'list': {
      const r = validateInteractivePayload(c as never)
      if (!r.ok) issues.push({ path: `${path}.interactive`, message: r.error })
      return
    }
    case 'media':
      if (!str(c.url)) issues.push({ path: `${path}.url`, message: 'media file is required' })
      if (!['image', 'video', 'document'].includes(String(c.media_kind))) {
        issues.push({ path: `${path}.media_kind`, message: 'media kind must be image, video, or document' })
      }
      return
    case 'audio':
      if (!str(c.url)) issues.push({ path: `${path}.url`, message: 'audio file is required' })
      return
    case 'template':
      if (!str(c.template_name)) issues.push({ path: `${path}.template_name`, message: 'template is required' })
      return
    case 'ask_question':
      if (!str(c.text)) issues.push({ path: `${path}.text`, message: 'question text is required' })
      if (!str(c.variable)) issues.push({ path: `${path}.variable`, message: 'variable name is required' })
      return
    case 'whatsapp_form':
      if (!str(c.flow_id)) issues.push({ path: `${path}.flow_id`, message: 'a published form is required' })
      return
    case 'payment': {
      const amt = Number(c.amount)
      if (!Number.isFinite(amt) || amt <= 0) {
        issues.push({ path: `${path}.amount`, message: 'payment amount must be greater than 0' })
      }
      if (!str(c.currency)) issues.push({ path: `${path}.currency`, message: 'currency is required' })
      return
    }
    case 'save_attribute':
      if (!str(c.field)) issues.push({ path: `${path}.field`, message: 'attribute is required' })
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'attribute value is required' })
      }
      return
    case 'add_tag':
      if (!str(c.tag_id)) issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      return
    case 'google_sheet':
      if (!str(c.spreadsheet)) issues.push({ path: `${path}.spreadsheet`, message: 'spreadsheet is required' })
      return
    case 'meta_capi':
      if (!str(c.event_type)) issues.push({ path: `${path}.event_type`, message: 'event type is required' })
      return
    case 'time_delay': {
      const amt = Number(c.amount)
      if (!Number.isFinite(amt) || amt < 0) {
        issues.push({ path: `${path}.amount`, message: 'delay must be a number of 0 or greater' })
      } else if (amt === 0) {
        // A 0-length delay is allowed but pointless — warn, don't block.
        issues.push({
          path: `${path}.amount`,
          message: 'delay is 0 — this step adds no pause',
          severity: 'warning',
        })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({ path: `${path}.unit`, message: 'delay unit must be minutes, hours, or days' })
      }
      return
    }
    case 'webhook':
      if (!str(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
      } else {
        try {
          const u = new URL(String(c.url))
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            issues.push({ path: `${path}.url`, message: 'webhook URL must use http or https' })
          }
        } catch {
          issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
        }
      }
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(String(c.method))) {
        issues.push({ path: `${path}.method`, message: 'HTTP method must be GET, POST, PUT, or DELETE' })
      }
      return
    case 'condition':
      if (!str(c.subject)) issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
      if (!str(c.operand)) issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
      return
    // Legacy passthroughs: reuse validateOne's exact invariants.
    // (add_tag/condition share the palette cases above.)
    case 'send_message':
    case 'send_buttons':
    case 'send_list':
    case 'send_template':
    case 'remove_tag':
    case 'assign_conversation':
    case 'update_contact_field':
    case 'create_deal':
    case 'wait':
    case 'send_webhook':
    case 'close_conversation': {
      const legacy = validateLegacyStepConfig(n.type, c)
      for (const i of legacy) issues.push({ path: `${path}.${i.path}`, message: i.message })
      return
    }
    default:
      issues.push({ path, message: `unknown node type: ${String(n.type)}` })
  }
}

function str(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * True when adding `source → target` to the edge set would create a
 * loop — i.e. a path from target back to source already exists. Used
 * by the edge POST endpoint for immediate feedback instead of a
 * publish-time surprise.
 */
export function wouldCreateCycle(
  edges: Pick<AutomationEdgeRow, 'source_node_id' | 'target_node_id'>[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true
  const out = new Map<string, string[]>()
  for (const e of edges) {
    const b = out.get(e.source_node_id)
    if (b) b.push(e.target_node_id)
    else out.set(e.source_node_id, [e.target_node_id])
  }
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of out.get(id) ?? []) stack.push(next)
  }
  return false
}
