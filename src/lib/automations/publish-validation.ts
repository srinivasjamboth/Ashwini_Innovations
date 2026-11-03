import type { SupabaseClient } from '@supabase/supabase-js'
import { validateGraphConfig } from './graph'
import { validateTriggerForActivation, type IssueSeverity } from './validate'
import type { AutomationEdgeRow, AutomationNodeRow } from './graph-types'

// ------------------------------------------------------------
// The publish gate, in one place.
//
// "Publish" is stricter than the plain Active toggle: it runs the full
// static validation (trigger + whole graph) AND re-checks every live
// external dependency, because a node's config is authored once but the
// resource it points at can change afterwards:
//   * every Template node's template must still be APPROVED on this
//     account;
//   * every WhatsApp Form node's form must still be published (with a
//     Meta flow id) on this account.
// Missing either is a BLOCKING error at publish time.
//
// Both the standalone publish route (POST /api/automations/[id]/publish)
// and the create-and-publish path (POST /api/automations { publish })
// call this, so the two entry points can never disagree about what is
// publishable. Returns every issue; callers split on severity — 'error'
// blocks, 'warning' only needs an acknowledgement click.
// ------------------------------------------------------------

export interface PublishIssue {
  path: string
  message: string
  severity: IssueSeverity
}

// Palette + legacy node types that resolve to a Meta template / form.
const TEMPLATE_TYPES = new Set(['template', 'send_template'])
const FLOW_TYPES = new Set(['whatsapp_form', 'send_flow'])

function toIssue(i: {
  path: string
  message: string
  severity?: IssueSeverity
}): PublishIssue {
  return { path: i.path, message: i.message, severity: i.severity ?? 'error' }
}

export async function collectPublishIssues(opts: {
  admin: SupabaseClient
  accountId: string
  triggerType?: string
  triggerConfig?: unknown
  nodes: AutomationNodeRow[]
  edges: AutomationEdgeRow[]
}): Promise<PublishIssue[]> {
  const { admin, accountId, triggerType, triggerConfig, nodes, edges } = opts

  // ---- static validation (trigger + whole graph) ----
  const issues: PublishIssue[] = [
    ...validateTriggerForActivation(triggerType ?? '', triggerConfig ?? {}),
    ...validateGraphConfig(nodes, edges),
  ].map(toIssue)

  const templateNodes = nodes.filter((n) => TEMPLATE_TYPES.has(n.type))
  const flowNodes = nodes.filter((n) => FLOW_TYPES.has(n.type))

  // ---- live re-check: templates still APPROVED ----
  if (templateNodes.length > 0) {
    const names = Array.from(
      new Set(
        templateNodes
          .map((n) => String((n.config ?? {}).template_name ?? ''))
          .filter(Boolean),
      ),
    )
    const approved = new Set<string>()
    // Carousels are Broadcasts-only in this version — a Template node
    // pointing at one must fail validation instead of silently failing
    // at send time.
    const carousels = new Set<string>()
    if (names.length > 0) {
      const { data, error } = await admin
        .from('message_templates')
        .select('name, language, header_type')
        .eq('account_id', accountId)
        .eq('status', 'APPROVED')
        .in('name', names)
      if (error) throw new Error(error.message)
      for (const row of data ?? []) {
        const lang = (row.language as string | undefined) ?? 'en_US'
        approved.add(`${row.name as string}::${lang}`)
        approved.add(row.name as string) // name-only fallback for blank lang
        if (row.header_type === 'carousel') {
          carousels.add(`${row.name as string}::${lang}`)
          carousels.add(row.name as string)
        }
      }
    }
    for (const n of templateNodes) {
      const name = String((n.config ?? {}).template_name ?? '').trim()
      const lang = String((n.config ?? {}).language ?? '').trim() || 'en_US'
      if (!name) continue // already a blocking error via validateGraphConfig
      const hit = lang ? approved.has(`${name}::${lang}`) : approved.has(name)
      if (!hit) {
        issues.push({
          path: `nodes.${n.id}.template_name`,
          message: `Template "${name}" (${lang}) is no longer approved and can't be sent`,
          severity: 'error',
        })
      } else if (carousels.has(`${name}::${lang}`) || carousels.has(name)) {
        issues.push({
          path: `nodes.${n.id}.template_name`,
          message: `Template "${name}" (${lang}) is a carousel — carousel templates can be sent from Broadcasts only`,
          severity: 'error',
        })
      }
    }
  }

  // ---- live re-check: forms still published ----
  if (flowNodes.length > 0) {
    const flowIds = Array.from(
      new Set(
        flowNodes
          .map((n) => String((n.config ?? {}).flow_id ?? ''))
          .filter(Boolean),
      ),
    )
    const published = new Set<string>()
    if (flowIds.length > 0) {
      const { data, error } = await admin
        .from('whatsapp_flows')
        .select('id')
        .eq('account_id', accountId)
        .eq('status', 'published')
        .not('meta_flow_id', 'is', null)
        .in('id', flowIds)
      if (error) throw new Error(error.message)
      for (const row of data ?? []) published.add(row.id as string)
    }
    for (const n of flowNodes) {
      const flowId = String((n.config ?? {}).flow_id ?? '').trim()
      if (!flowId) continue // already a blocking error via validateGraphConfig
      if (!published.has(flowId)) {
        issues.push({
          path: `nodes.${n.id}.flow_id`,
          message: "The selected form is no longer published and can't be sent",
          severity: 'error',
        })
      }
    }
  }

  return issues
}

/** Split a collected issue list into the two buckets the UI renders. */
export function splitPublishIssues(issues: PublishIssue[]): {
  errors: PublishIssue[]
  warnings: PublishIssue[]
} {
  return {
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  }
}
