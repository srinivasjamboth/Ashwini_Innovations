import {
  Activity,
  CircleHelp,
  ClipboardList,
  Clock,
  CreditCard,
  FileText,
  GitBranch,
  Image,
  LayoutList,
  MessageSquare,
  Mic,
  Save,
  Sheet,
  Tag,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

// ------------------------------------------------------------
// Automation graph builder — node catalog & config models.
//
// The canvas authors a node/edge graph (automation_nodes /
// automation_edges). `graph.ts` compiles that graph into the
// `automation_steps` tree the execution engine runs, and decompiles
// step trees back into a graph so legacy automations open on the
// canvas unchanged.
// ------------------------------------------------------------

/** The 15 canvas palette types. */
export const PALETTE_NODE_TYPES = [
  // Messages tab, in spec order
  'text_button',
  'media',
  'audio',
  'list',
  'template',
  'ask_question',
  'whatsapp_form',
  'payment',
  // Actions tab, in spec order
  'save_attribute',
  'add_tag',
  'google_sheet',
  'meta_capi',
  'time_delay',
  'webhook',
  'condition',
] as const

export type PaletteNodeType = (typeof PALETTE_NODE_TYPES)[number]

/** Legacy step types still stored on pre-canvas automations. They stay
 *  first-class node types so existing step trees round-trip losslessly. */
export const LEGACY_NODE_TYPES = [
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
  'add_tag',
  'remove_tag',
  'assign_conversation',
  'update_contact_field',
  'create_deal',
  'wait',
  'condition',
  'send_webhook',
  'close_conversation',
] as const

export type AutomationNodeType = 'starting_step' | PaletteNodeType | (typeof LEGACY_NODE_TYPES)[number]

export function isAutomationNodeType(v: unknown): v is AutomationNodeType {
  return (
    v === 'starting_step' ||
    (PALETTE_NODE_TYPES as readonly string[]).includes(v as string) ||
    (LEGACY_NODE_TYPES as readonly string[]).includes(v as string)
  )
}

// ------------------------------------------------------------
// Palette node configs (stored verbatim in automation_nodes.config,
// then compiled into engine step configs).
// ------------------------------------------------------------

/** Media node: image / video / document upload (Meta accepts a caption
 *  on all three; only documents carry a filename). */
export interface MediaNodeConfig {
  media_kind: 'image' | 'video' | 'document'
  url: string
  caption?: string
  filename?: string
}

export interface AudioNodeConfig {
  url: string
}

export interface TemplateNodeConfig {
  template_name: string
  language?: string
  /** @deprecated legacy positional map; kept for backward compat. */
  variables?: Record<string, string>
  body?: string[]
  headerText?: string
  buttonParams?: Record<string, string>
}

/** Ask a Question: sends `text`, parks the run, stores the contact's
 *  reply under `vars.<variable>` so downstream steps can interpolate
 *  `{{ vars.<variable> }}`. */
export interface AskQuestionNodeConfig {
  text: string
  variable: string
}

export interface WhatsAppFormNodeConfig {
  /** Published WhatsApp Flow id (from /api/whatsapp-flows/published). */
  flow_id: string
}

/** WhatsApp Cloud API has no native payment primitive — the node
 *  compiles to a payment-request text message carrying these details. */
export interface PaymentNodeConfig {
  amount: number
  currency: string
  description?: string
}

export interface SaveAttributeNodeConfig {
  /** Built-in column (`name` | `email` | `company`) or `custom:<field_id>`
   *  — the same encoding the update_contact_field engine step uses. */
  field: string
  /** Static text or a `{{ vars.* }}` / `{{ message.text }}` reference. */
  value: string
}

export interface AddTagNodeConfig {
  tag_id: string
}

export interface GoogleSheetNodeConfig {
  spreadsheet: string
  mapping: { column: string; value: string }[]
}

export interface MetaCapiNodeConfig {
  event_type: string
  custom_data: { key: string; value: string }[]
}

export interface TimeDelayNodeConfig {
  amount: number
  unit: 'minutes' | 'hours' | 'days'
}

export interface WebhookNodeConfig {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  payload?: string
}

/** Mirrors the engine's ConditionStepConfig — subject picks the
 *  comparison, operand/value are subject-specific. */
export interface ConditionNodeConfig {
  subject: 'contact_field' | 'tag_presence' | 'message_content' | 'time_of_day'
  operand?: string
  value?: string
}

// ------------------------------------------------------------
// Catalog metadata driving the canvas cards, the Select Action
// modal grid, and the starting node. Icons/colors follow the
// NODE_META conventions of the flows module.
// ------------------------------------------------------------

export interface AutomationNodeMeta {
  icon: LucideIcon
  /** Tailwind classes for the icon chip + accent border, mirroring
   *  the TriggerCard pattern (bg-<hue>-500/10 text-<hue>-400). */
  color: string
  category: 'messages' | 'actions' | 'trigger' | 'legacy'
  /** i18n key under the Automations namespace: nodeTypes.<type>.label */
  labelKey: string
}

// Palette and legacy types that share a name (`add_tag`, `condition`)
// have identical semantics — one entry serves both. Legacy-only types
// render on the canvas so pre-canvas automations round-trip losslessly.
export const AUTOMATION_NODE_META: Record<AutomationNodeType, AutomationNodeMeta> = {
  starting_step: {
    icon: Zap,
    color: 'blue',
    category: 'trigger',
    labelKey: 'trigger',
  },
  // ---- Messages palette (exact spec order) ----
  text_button: { icon: MessageSquare, color: 'emerald', category: 'messages', labelKey: 'text_button' },
  media: { icon: Image, color: 'violet', category: 'messages', labelKey: 'media' },
  audio: { icon: Mic, color: 'fuchsia', category: 'messages', labelKey: 'audio' },
  list: { icon: LayoutList, color: 'teal', category: 'messages', labelKey: 'list' },
  template: { icon: FileText, color: 'indigo', category: 'messages', labelKey: 'template' },
  ask_question: { icon: CircleHelp, color: 'amber', category: 'messages', labelKey: 'ask_question' },
  whatsapp_form: { icon: ClipboardList, color: 'cyan', category: 'messages', labelKey: 'whatsapp_form' },
  payment: { icon: CreditCard, color: 'orange', category: 'messages', labelKey: 'payment' },
  // ---- Actions palette (exact spec order) ----
  save_attribute: { icon: Save, color: 'violet', category: 'actions', labelKey: 'save_attribute' },
  add_tag: { icon: Tag, color: 'sky', category: 'actions', labelKey: 'add_tag' },
  google_sheet: { icon: Sheet, color: 'green', category: 'actions', labelKey: 'google_sheet' },
  meta_capi: { icon: Activity, color: 'blue', category: 'actions', labelKey: 'meta_capi' },
  time_delay: { icon: Clock, color: 'amber', category: 'actions', labelKey: 'time_delay' },
  webhook: { icon: Webhook, color: 'cyan', category: 'actions', labelKey: 'webhook' },
  condition: { icon: GitBranch, color: 'rose', category: 'actions', labelKey: 'condition' },
  // ---- Legacy passthrough ----
  send_message: { icon: MessageSquare, color: 'emerald', category: 'legacy', labelKey: 'send_message' },
  send_buttons: { icon: MessageSquare, color: 'emerald', category: 'legacy', labelKey: 'send_buttons' },
  send_list: { icon: LayoutList, color: 'emerald', category: 'legacy', labelKey: 'send_list' },
  send_template: { icon: FileText, color: 'emerald', category: 'legacy', labelKey: 'send_template' },
  remove_tag: { icon: Tag, color: 'sky', category: 'legacy', labelKey: 'remove_tag' },
  assign_conversation: { icon: Save, color: 'violet', category: 'legacy', labelKey: 'assign_conversation' },
  update_contact_field: { icon: Save, color: 'violet', category: 'legacy', labelKey: 'update_contact_field' },
  create_deal: { icon: CreditCard, color: 'orange', category: 'legacy', labelKey: 'create_deal' },
  wait: { icon: Clock, color: 'amber', category: 'legacy', labelKey: 'wait' },
  send_webhook: { icon: Webhook, color: 'cyan', category: 'legacy', labelKey: 'send_webhook' },
  close_conversation: { icon: Clock, color: 'slate', category: 'legacy', labelKey: 'close_conversation' },
}

/** Palette entries shown in the Select Action modal, grouped + ordered. */
export const MESSAGES_TAB_TYPES: PaletteNodeType[] = [
  'text_button',
  'media',
  'audio',
  'list',
  'template',
  'ask_question',
  'whatsapp_form',
  'payment',
]

export const ACTIONS_TAB_TYPES: PaletteNodeType[] = [
  'save_attribute',
  'add_tag',
  'google_sheet',
  'meta_capi',
  'time_delay',
  'webhook',
  'condition',
]

/** Blank config seeded when a palette node is created on the canvas. */
export function blankPaletteConfig(type: PaletteNodeType): Record<string, unknown> {
  switch (type) {
    case 'text_button':
      return { kind: 'buttons', body: '', buttons: [{ id: '', title: '' }] } satisfies InteractiveMessagePayload
    case 'media':
      return { media_kind: 'image', url: '', caption: '' }
    case 'audio':
      return { url: '' }
    case 'list':
      return {
        kind: 'list',
        body: '',
        button_label: '',
        sections: [{ rows: [{ id: '', title: '' }] }],
      } satisfies InteractiveMessagePayload
    case 'template':
      return { template_name: '', language: '', variables: {} }
    case 'ask_question':
      return { text: '', variable: '' }
    case 'whatsapp_form':
      return { flow_id: '' }
    case 'payment':
      return { amount: 0, currency: 'INR', description: '' }
    case 'save_attribute':
      return { field: '', value: '' }
    case 'add_tag':
      return { tag_id: '' }
    case 'google_sheet':
      return { spreadsheet: '', mapping: [] }
    case 'meta_capi':
      return { event_type: '', custom_data: [] }
    case 'time_delay':
      return { amount: 30, unit: 'minutes' }
    case 'webhook':
      return { url: '', method: 'POST', headers: {}, payload: '' }
    case 'condition':
      return { subject: 'tag_presence', operand: '', value: '' }
    default:
      return assertNever(type)
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected node type: ${String(value)}`)
}

/** Graph-level row shapes (mirror the 055 migration). */
export interface AutomationNodeRow {
  id: string
  automation_id: string
  account_id: string
  type: AutomationNodeType
  config: Record<string, unknown>
  position_x: number
  position_y: number
  created_at?: string
  updated_at?: string
}

export interface AutomationEdgeRow {
  id: string
  automation_id: string
  account_id: string
  source_node_id: string
  target_node_id: string
  source_handle: 'yes' | 'no' | null
  created_at?: string
}
