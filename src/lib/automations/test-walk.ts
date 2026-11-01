import type { AutomationTriggerType } from '@/types'
import type { InteractiveListPayload, InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  type AutomationEdgeRow,
  type AutomationNodeRow,
  type AutomationNodeType,
} from './graph-types'

// ------------------------------------------------------------
// Test-mode graph walker — a 100% CLIENT-SIDE dry run.
//
// Mirrors the execution engine's control flow (trigger match, branch
// resolution, condition evaluation, `{{ }}` interpolation) so the
// simulator behaves like production, but touches NOTHING real:
//   * no trigger_count / execution_count increment
//   * no Conversation / Message / automation_logs rows
//   * no writes to Contact / Tag / ContactAttribute
//   * no outbound webhook / Google Sheet / Meta CAPI / payment calls
//   * no Meta sends
//
// Every "send" node becomes an inline chat bubble; every action node a
// `dryrun` system line ("Would …"). Condition nodes evaluate against a
// supplied test context (manual values or a real contact snapshot the
// caller fetched read-only) and record which branch was taken and why.
//
// The pure helpers here are unit-tested directly (test-walk.test.ts).
// ------------------------------------------------------------

/** A snapshot of the contact a Condition node is evaluated against.
 *  In "manual" mode the tester fills `fields` / `tagIds` directly; in
 *  "real contact" mode the panel loads them read-only. */
export interface TestContact {
  name: string
  /** Built-in columns (name/email/company) keyed directly, custom
   *  fields keyed as `custom:<id>` — same encoding the engine uses. */
  fields: Record<string, string | number | null>
  tagIds: string[]
}

export interface TestContext {
  /** Last inbound message text (the entry message, a typed Ask-a-Question
   *  reply, or a tapped button/row id) — powers `{{ message.text }}` and
   *  the `message_content` condition subject. */
  messageText: string
  /** Accumulated Ask-a-Question answers, keyed by variable name. */
  vars: Record<string, string>
  contact: TestContact
}

export function emptyContext(): TestContext {
  return { messageText: '', vars: {}, contact: { name: '', fields: {}, tagIds: [] } }
}

// ------------------------------------------------------------
// Branch resolution
// ------------------------------------------------------------

/** Follow a node's outgoing edge. Linear nodes use the (single) edge
 *  with `source_handle === null`; condition nodes pick 'yes' / 'no'. */
export function resolveNext(
  edges: AutomationEdgeRow[],
  nodeId: string,
  handle: 'yes' | 'no' | null = null,
): string | null {
  const candidates = edges.filter(
    (e) => e.source_node_id === nodeId && (e.source_handle ?? null) === handle,
  )
  // created_at ordering (compile semantics) — take the first authored.
  return candidates[0]?.target_node_id ?? null
}

// ------------------------------------------------------------
// Interpolation — engine-identical (`{{ message.text }}`, `{{ vars.x }}`)
// ------------------------------------------------------------

export function interpolateVars(s: string, ctx: TestContext): string {
  return String(s ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(ctx.messageText ?? '')
    if (ns === 'vars' && prop) return String(ctx.vars?.[prop] ?? '')
    return ''
  })
}

// ------------------------------------------------------------
// Trigger matching — mirrors engine.triggerMatches (message keyword /
// interactive reply only; time_based / tag_added always "match" in the
// simulator since the tester supplies the entry message directly).
// ------------------------------------------------------------

function matchesWholeWord(text: string, keyword: string, caseSensitive = false): boolean {
  if (!keyword) return false
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

export function simulateTriggerMatch(
  triggerType: AutomationTriggerType,
  triggerConfig: Record<string, unknown>,
  messageText: string,
): { matched: boolean; reason: string } {
  if (triggerType === 'keyword_match') {
    const cfg = triggerConfig as {
      keywords?: string[]
      match_type?: 'exact' | 'contains' | 'word'
      case_sensitive?: boolean
    }
    const keywords = Array.isArray(cfg?.keywords) ? cfg.keywords : []
    if (keywords.length === 0) {
      return { matched: false, reason: 'no keywords configured' }
    }
    const text = messageText ?? ''
    if (!text) return { matched: false, reason: 'empty message' }
    const cs = cfg.case_sensitive === true
    let matched = false
    if (cfg.match_type === 'word') {
      matched = keywords.some((k) => matchesWholeWord(text, k, cs))
    } else {
      const hay = cs ? text : text.toLowerCase()
      matched = keywords.some((raw) => {
        const k = cs ? raw : raw.toLowerCase()
        return cfg.match_type === 'exact' ? hay === k : hay.includes(k)
      })
    }
    return {
      matched,
      reason: matched
        ? 'message matched a trigger keyword'
        : 'message did not match any trigger keyword',
    }
  }
  // interactive_reply / tag_added / time_based / conversation_assigned:
  // the tester is driving entry directly, so accept the message.
  return { matched: true, reason: 'trigger accepted the test message' }
}

// ------------------------------------------------------------
// Condition evaluation — mirrors engine.evaluateCondition, but reads
// the supplied TestContact snapshot instead of the database.
// ------------------------------------------------------------

export function evaluateCondition(
  cfg: { subject: string; operand?: string; value?: string },
  ctx: TestContext,
): { result: boolean; reason: string } {
  switch (cfg.subject) {
    case 'tag_presence': {
      const tagId = cfg.operand ?? ''
      const result = ctx.contact.tagIds.includes(tagId)
      return {
        result,
        reason: result
          ? 'contact has the checked tag'
          : 'contact does NOT have the checked tag',
      }
    }
    case 'contact_field': {
      const col = cfg.operand ?? ''
      const raw = ctx.contact.fields[col]
      const result = raw != null && String(raw) === String(cfg.value ?? '')
      return {
        result,
        reason: `${col || '(field)'} = ${raw == null ? '∅' : String(raw)} ${
          result ? '==' : '!='
        } "${cfg.value ?? ''}"`,
      }
    }
    case 'message_content': {
      const needle = (cfg.value ?? '').toLowerCase()
      const result = (ctx.messageText ?? '').toLowerCase().includes(needle)
      return {
        result,
        reason: result
          ? `message contains "${cfg.value ?? ''}"`
          : `message does not contain "${cfg.value ?? ''}"`,
      }
    }
    case 'time_of_day': {
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return { result: false, reason: 'invalid time window' }
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      const result = f <= t ? mins >= f && mins < t : mins >= f || mins < t
      return { result, reason: `current time ${result ? 'is' : 'is not'} within ${from}-${to}` }
    }
    default:
      return { result: false, reason: 'unknown condition subject' }
  }
}

// ------------------------------------------------------------
// Node descriptors — what the panel renders for each node type.
// ------------------------------------------------------------

/** A rendered chat bubble produced by a "send"-style node. */
export type BotBubble =
  | { type: 'text'; text: string; header?: string; footer?: string }
  | { type: 'buttons'; text: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | { type: 'list'; text: string; buttonLabel?: string; sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] }
  | { type: 'media'; kind: 'image' | 'video' | 'document'; url: string; caption?: string; filename?: string }
  | { type: 'audio'; url: string }
  | { type: 'template'; name: string; language: string; body: string; buttons: string[] }
  | { type: 'form'; flowName: string; flowId: string }
  | { type: 'question'; text: string; variable: string }
  | { type: 'payment'; amount: number; currency: string; description?: string }

/**
 * Whether a node PAUSES the walk awaiting tester input, and which kind.
 *  - 'buttons' / 'list' → tester taps an option, walk continues linearly
 *  - 'question' → tester types a reply (stored to `variable`), continues
 *  - 'form' → tester submits (dry-run), continues
 */
export type AwaitKind = 'buttons' | 'list' | 'question' | 'form'

export interface NodeProcessing {
  /** Bubble to render, or null for action-only nodes. */
  bubble: BotBubble | null
  /** System lines (dry-run descriptions, condition outcome, end markers). */
  system: { tone: 'dryrun' | 'condition' | 'warn' | 'info'; text: string }[]
  /** Pause kind + the node id to resume from after input. */
  awaits: AwaitKind | null
  /** For interactive bubbles, the option list to render as tappable. */
  nextHandle: 'yes' | 'no' | null
}

function cfgStr(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key]
  return v == null ? '' : String(v)
}

/**
 * Describe one node's dry-run output. `resources` supplies display names
 * (tag names, template bodies, flow names) resolved by the caller from
 * the shared ResourcesProvider — pass empty maps when unavailable.
 */
export function describeNode(
  node: AutomationNodeRow,
  ctx: TestContext,
  resources: {
    tagNames: Record<string, string>
    templates: Record<string, { body_text: string; buttons?: { text: string }[] }>
    flowNames: Record<string, string>
  },
): NodeProcessing {
  const cfg = node.config ?? {}
  const sys = (text: string, tone: 'dryrun' | 'condition' | 'warn' | 'info' = 'dryrun') => ({
    tone,
    text,
  })

  switch (node.type) {
    case 'starting_step':
      return { bubble: null, system: [], awaits: null, nextHandle: null }

    case 'text_button': {
      const p = cfg as unknown as InteractiveMessagePayload
      const text = interpolateVars(p.body ?? '', ctx)
      if (p.kind === 'list') {
        const sections = (p.sections ?? []).map((s) => ({
          title: s.title,
          rows: (s.rows ?? []).map((r) => ({
            id: r.id,
            title: interpolateVars(r.title ?? '', ctx),
            description: r.description ? interpolateVars(r.description, ctx) : undefined,
          })),
        }))
        return {
          bubble: {
            type: 'list',
            text,
            buttonLabel: p.button_label ? interpolateVars(p.button_label, ctx) : undefined,
            sections,
          },
          system: [],
          awaits: 'list',
          nextHandle: null,
        }
      }
      const buttons = (p.buttons ?? []).map((b) => ({
        id: b.id,
        title: interpolateVars(b.title ?? '', ctx),
      }))
      return {
        bubble: {
          type: 'buttons',
          text,
          header: p.header ? interpolateVars(p.header, ctx) : undefined,
          footer: p.footer ? interpolateVars(p.footer, ctx) : undefined,
          buttons,
        },
        system: [],
        awaits: 'buttons',
        nextHandle: null,
      }
    }

    case 'media': {
      const kind = (cfgStr(cfg, 'media_kind') || 'image') as 'image' | 'video' | 'document'
      const url = cfgStr(cfg, 'url')
      return {
        bubble: {
          type: 'media',
          kind,
          url,
          caption: cfgStr(cfg, 'caption') ? interpolateVars(cfgStr(cfg, 'caption'), ctx) : undefined,
          filename: cfgStr(cfg, 'filename') || undefined,
        },
        system: url ? [] : [sys('Media node has no file uploaded', 'warn')],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'audio': {
      const url = cfgStr(cfg, 'url')
      return {
        bubble: { type: 'audio', url },
        system: url ? [] : [sys('Audio node has no file uploaded', 'warn')],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'list': {
      // Palette list is stored as an interactive payload too.
      const p = cfg as unknown as InteractiveListPayload
      const sections = (p.sections ?? []).map((s) => ({
        title: s.title,
        rows: (s.rows ?? []).map((r) => ({
          id: r.id,
          title: interpolateVars(r.title ?? '', ctx),
          description: r.description ? interpolateVars(r.description, ctx) : undefined,
        })),
      }))
      return {
        bubble: {
          type: 'list',
          text: interpolateVars(p.body ?? '', ctx),
          buttonLabel: p.button_label ? interpolateVars(p.button_label, ctx) : undefined,
          sections,
        },
        system: [],
        awaits: 'list',
        nextHandle: null,
      }
    }

    case 'template': {
      const name = cfgStr(cfg, 'template_name')
      const language = cfgStr(cfg, 'language') || 'en_US'
      const tmpl = resources.templates[name]
      const bodyVars = Array.isArray(cfg.body) ? (cfg.body as string[]).map((v) => interpolateVars(v, ctx)) : []
      let body = ''
      if (tmpl?.body_text) {
        body = tmpl.body_text.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
          const v = bodyVars[Number(raw) - 1]
          return v && v.trim() ? v : `{{${raw}}}`
        })
      } else if (bodyVars.length) {
        body = bodyVars.join(', ')
      }
      const buttons = (tmpl?.buttons ?? []).map((b) => b.text)
      return {
        bubble: { type: 'template', name, language, body: body || '', buttons },
        system: name ? [] : [sys('Template node has no template selected', 'warn')],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'ask_question': {
      const text = interpolateVars(cfgStr(cfg, 'text'), ctx)
      const variable = cfgStr(cfg, 'variable')
      return {
        bubble: { type: 'question', text, variable },
        system: variable
          ? []
          : [sys('Ask a Question node has no save-to variable set', 'warn')],
        awaits: 'question',
        nextHandle: null,
      }
    }

    case 'whatsapp_form': {
      const flowId = cfgStr(cfg, 'flow_id')
      const flowName = resources.flowNames[flowId] ?? flowId
      return {
        bubble: { type: 'form', flowId, flowName: flowName || '(no form selected)' },
        system: flowId ? [] : [sys('Form node has no form selected', 'warn')],
        awaits: 'form',
        nextHandle: null,
      }
    }

    case 'payment': {
      const amount = Number(cfgStr(cfg, 'amount') || 0)
      return {
        bubble: null,
        system: [
          sys(
            `Would request a payment of ${amount} ${cfgStr(cfg, 'currency') || 'INR'}` +
              (cfgStr(cfg, 'description') ? ` — ${cfgStr(cfg, 'description')}` : ''),
          ),
        ],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'save_attribute':
    case 'update_contact_field': {
      const field = cfgStr(cfg, 'field') || cfgStr(cfg, 'custom_field_id')
      const value = interpolateVars(cfgStr(cfg, 'value'), ctx)
      return {
        bubble: null,
        system: [sys(`Would save attribute: ${field || '(field)'} = ${value || '(empty)'}`)],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'add_tag': {
      const tagId = cfgStr(cfg, 'tag_id')
      const tagName = resources.tagNames[tagId] ?? tagId
      return {
        bubble: null,
        system: [sys(`Would add tag: ${tagName || '(no tag selected)'}`)],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'remove_tag': {
      const tagId = cfgStr(cfg, 'tag_id')
      const tagName = resources.tagNames[tagId] ?? tagId
      return {
        bubble: null,
        system: [sys(`Would remove tag: ${tagName || '(no tag selected)'}`)],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'google_sheet': {
      const sheet = cfgStr(cfg, 'spreadsheet')
      const rows = Array.isArray(cfg.mapping)
        ? (cfg.mapping as { column?: string; value?: string }[])
            .map((m) => `${m.column ?? ''}=${interpolateVars(m.value ?? '', ctx)}`)
            .filter((s) => s !== '=')
            .join(', ')
        : ''
      return {
        bubble: null,
        system: [sys(`Would write to Google Sheet: ${sheet || '(spreadsheet)'}${rows ? ` (${rows})` : ''}`)],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'meta_capi': {
      const event = cfgStr(cfg, 'event_type')
      return {
        bubble: null,
        system: [sys(`Would send Meta Conversion API event: ${event || '(event)'}`)],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'webhook':
    case 'send_webhook': {
      const method = cfgStr(cfg, 'method') || 'POST'
      const url = cfgStr(cfg, 'url')
      return {
        bubble: null,
        system: [sys(`Would call webhook: ${method} ${url || '(no url)'}`)],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'time_delay':
    case 'wait': {
      const amount = Number(cfgStr(cfg, 'amount'))
      const unit = cfgStr(cfg, 'unit') || 'minutes'
      const valid = Number.isFinite(amount)
      return {
        bubble: null,
        system: valid
          ? [sys(`Would pause for ${amount} ${unit} before continuing`, 'info')]
          : [sys('Time Delay node has an invalid amount', 'warn')],
        awaits: null,
        nextHandle: null,
      }
    }

    case 'condition': {
      const { result, reason } = evaluateCondition(
        {
          subject: cfgStr(cfg, 'subject'),
          operand: cfgStr(cfg, 'operand'),
          value: cfgStr(cfg, 'value'),
        },
        ctx,
      )
      return {
        bubble: null,
        system: [
          sys(
            `Condition → ${result ? 'Yes' : 'No'}: ${reason}`,
            'condition',
          ),
        ],
        awaits: null,
        nextHandle: result ? 'yes' : 'no',
      }
    }

    // Legacy passthroughs with no richer behaviour than a note.
    case 'assign_conversation':
    case 'create_deal':
    case 'close_conversation':
      return {
        bubble: null,
        system: [sys(`Would run "${node.type}" action (dry-run, no side effects)`, 'info')],
        awaits: null,
        nextHandle: null,
      }

    case 'send_message':
    case 'send_buttons':
    case 'send_list':
    case 'send_template':
      return {
        bubble: {
          type: 'text',
          text: interpolateVars(cfgStr(cfg, 'text') || cfgStr(cfg, 'body') || '', ctx),
        },
        system: [],
        awaits: null,
        nextHandle: null,
      }

    default:
      return {
        bubble: null,
        system: [sys(`No simulator for node type "${node.type as AutomationNodeType}"`, 'warn')],
        awaits: null,
        nextHandle: null,
      }
  }
}
