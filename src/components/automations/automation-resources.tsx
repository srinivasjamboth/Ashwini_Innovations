"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import type {
  AccountMember,
  CustomField,
  InteractiveMessagePayload,
  MessageTemplate,
  PublishedFlowOption,
  Tag as TagRecord,
} from "@/types"
import { createClient } from "@/lib/supabase/client"
import { extractVariableIndices } from "@/lib/whatsapp/template-validators"

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, custom
// fields, pipelines, published WhatsApp Flows).
//
// Extracted from the vertical builder so the canvas shell, the
// node config panel, and the trigger form all share one loader.
// Loaded once at the builder root and shared via context so the
// pickers offer existing resources by name instead of asking the
// user to paste raw UUIDs. Every picker falls back to a raw input
// when its list is empty (fresh account or an older deployment),
// so an automation is always authorable.
// ------------------------------------------------------------

export interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
  publishedFlows: PublishedFlowOption[]
}

export interface PipelineOption {
  id: string
  name: string
}

export interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
  publishedFlows: [],
})

export function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

export function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [pipelines, setPipelines] = useState<PipelineOption[]>([])
  const [stages, setStages] = useState<PipelineStageOption[]>([])
  const [publishedFlows, setPublishedFlows] = useState<PublishedFlowOption[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, custom fields and pipelines come straight from the DB — RLS
    // scopes them to the caller's account.
    //
    // Templates do NOT: they load from /api/automations/templates below,
    // through the server (RLS) client and account-scoped. A direct
    // browser → Supabase query returns rows only when auth.uid() resolves
    // to a confirmed session, so an account member whose email isn't
    // confirmed saw an empty Template dropdown. The server route removes
    // that dependency (same source-of-truth pattern as the Forms node).
    void (async () => {
      const [tagsRes, customFieldsRes, pipelinesRes, stagesRes] =
        await Promise.all([
          supabase.from("tags").select("*").order("name"),
          supabase.from("custom_fields").select("*").order("field_name"),
          supabase.from("pipelines").select("id, name").order("name"),
          supabase
            .from("pipeline_stages")
            .select("id, name, pipeline_id, position")
            .order("position"),
        ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? [])
      setStages((stagesRes.data as PipelineStageOption[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    // Published WhatsApp Flows for the WhatsApp Form node dropdown.
    // Same graceful degradation: no endpoint rows → raw id input.
    void (async () => {
      try {
        const res = await fetch("/api/whatsapp-flows/published", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { flows?: PublishedFlowOption[] }
        if (!cancelled) setPublishedFlows(json.flows ?? [])
      } catch {
        // Endpoint absent — the form picker falls back to a raw input.
      }
    })()

    // Approved templates for the Template node dropdown, through the
    // server (RLS) route so it doesn't depend on a confirmed client
    // session. Graceful: a missing/older endpoint leaves the list empty
    // and the picker shows the "create one on Templates first" hint.
    void (async () => {
      try {
        const res = await fetch("/api/automations/templates", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { templates?: MessageTemplate[] }
        if (!cancelled) setTemplates(json.templates ?? [])
      } catch {
        // Endpoint absent — the template picker stays empty.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ResourcesContext.Provider
      value={{ tags, members, templates, customFields, pipelines, stages, publishedFlows }}
    >
      {children}
    </ResourcesContext.Provider>
  )
}

export const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

// The text_button / list node config IS an InteractiveMessagePayload,
// but node config is typed generically as Record<string, unknown>.
// These two helpers hold the single unavoidable structural cast in one
// place so a payload-shape change has one seam to update.
export function asInteractiveCfg(cfg: Record<string, unknown>): InteractiveMessagePayload {
  return cfg as unknown as InteractiveMessagePayload
}
export function toCfg(p: InteractiveMessagePayload): Record<string, unknown> {
  return p as unknown as Record<string, unknown>
}

export function FieldBlock({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// Mirrors the `useTranslations("Automations.builder")` return type the
// builder shell holds; pickers take the caller's translator so keypaths
// stay relative to that namespace.
type T = ReturnType<typeof useTranslations>

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
export function TagSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: T
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder={t("tags.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("tags.select")}</option>
        {tags.map((tg) => (
          <option key={tg.id} value={tg.id}>
            {tg.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t("tags.unknown", { id: value })}</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Save Attribute" / "Update Contact Field":
 *  built-in columns plus any account custom fields (stored as
 *  `custom:<id>`). A saved custom field that's since been deleted is
 *  preserved as a labelled option so editing an existing automation
 *  doesn't silently drop it. */
export function ContactFieldSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: T
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t("fields.name")}</option>
      <option value="email">{t("fields.email")}</option>
      <option value="company">{t("fields.company")}</option>
      {customFields.length > 0 && (
        <optgroup label={t("fields.customFields")}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{t("fields.unknown", { id: customValue })}</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
export function AgentSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: T
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder={t("agents.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t("agents.select")}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{t("agents.unknown", { id: value })}</option>
      )}
    </select>
  )
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
export function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
  t,
}: {
  pipelineId: string
  stageId: string
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void
  t: T
}) {
  const { pipelines, stages } = useResources()

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label={t("pipelines.pipelineIdLabel")}>
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("pipelines.stageIdLabel")}>
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId)
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId)
  const selectedStage = stageOptions.find((s) => s.id === stageId)

  return (
    <>
      <FieldBlock label={t("pipelines.pipelineLabel")}>
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            )
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? "",
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("pipelines.selectPipeline")}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>{t("pipelines.unknownPipeline", { id: pipelineId })}</option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label={t("pipelines.stageLabel")}>
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId ? t("pipelines.selectStage") : t("pipelines.selectPipelineFirst")}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>{t("pipelines.unknownStage", { id: stageId })}</option>
          )}
        </select>
      </FieldBlock>
    </>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. Serves the
 *  palette `template` node and the legacy `send_template` node alike. */
export function SendTemplateFields({
  templateName,
  language,
  onChange,
  t,
}: {
  templateName: string
  language: string
  onChange: (patch: { template_name: string; language: string }) => void
  t: T
}) {
  const { templates } = useResources()

  // Choices come only from the Templates page (approved, sendable
  // templates) — no manual name/language entry. A saved template that
  // has since been deleted still shows as a labelled option so editing
  // an existing automation doesn't silently drop it.
  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  return (
    <FieldBlock label={t("templates.templateLabel")}>
      <select
        value={current}
        onChange={(e) => {
          const [name, lang] = e.target.value.split("::")
          onChange({ template_name: name ?? "", language: lang ?? "" })
        }}
        className={SELECT_CLASS}
        disabled={templates.length === 0}
      >
        <option value="">{t("templates.select")}</option>
        {templates.map((tmpl) => {
          const lang = tmpl.language ?? "en_US"
          // Carousel templates are Broadcasts-only in this version: show
          // them disabled with a note instead of hiding them, so the
          // picker stays honest about what exists.
          const isCarousel = tmpl.header_type === "carousel"
          return (
            <option key={tmpl.id} value={toValue(tmpl.name, lang)} disabled={isCarousel}>
              {tmpl.name} ({lang})
              {isCarousel ? ` — ${t("templates.broadcastOnly")}` : ""}
            </option>
          )
        })}
        {current && !hasMatch && (
          <option value={current}>
            {t("templates.unknown", { name: templateName, lang: language || t("templates.unknownLang") })}
          </option>
        )}
      </select>
      {templates.length === 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">{t("config.noTemplates")}</p>
      )}
    </FieldBlock>
  )
}

/**
 * Which send-time slots a template needs filled:
 *   - `bodyVars`: the {{1}}, {{2}}, … indices in the body (Meta keeps
 *     these contiguous from 1, so the index is also the array position).
 *   - `headerVar`: a TEXT header carrying {{1}}.
 *   - `urlButtons`: URL buttons whose link has a {{1}} suffix.
 *
 * COPY_CODE buttons are intentionally omitted — buildSendComponents falls
 * back to the template's stored example, so they need no authoring.
 */
export interface TemplateSlots {
  bodyVars: number[]
  headerVar: boolean
  urlButtons: { index: number; text: string }[]
}

export function collectTemplateSlots(tmpl: MessageTemplate): TemplateSlots {
  const bodyVars = extractVariableIndices(tmpl.body_text)
  const headerVar =
    tmpl.header_type === "text" &&
    !!tmpl.header_content &&
    extractVariableIndices(tmpl.header_content).length > 0
  const urlButtons: { index: number; text: string }[] = []
  ;(tmpl.buttons ?? []).forEach((b, i) => {
    if (b.type === "URL" && extractVariableIndices(b.url ?? "").length > 0) {
      urlButtons.push({ index: i, text: b.text })
    }
  })
  return { bodyVars, headerVar, urlButtons }
}

/** Substitute entered body values into the {{N}} tokens for a live
 *  preview; unfilled tokens stay visible as {{N}}. */
function previewBody(bodyText: string, body: string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const value = body[Number(raw) - 1]
    return value && value.trim().length > 0 ? value : `{{${raw}}}`
  })
}

/**
 * Per-variable inputs for the selected template, mirroring the inbox
 * send picker's slots. Values may embed `{{ vars.x }}` / `{{ message.text }}`
 * so a slot can be static OR pulled per-contact from an earlier Ask-a-Question
 * answer / contact field — the engine interpolates each value before send.
 *
 * Stores into the node config as `body: string[]` (position = {{N}}),
 * `headerText`, and `buttonParams` (keyed by button index), which the
 * engine forwards to Meta's structured `components` (header + body +
 * buttons), not just body-only.
 */
export function TemplateVariablesFields({
  templateName,
  language,
  cfg,
  set,
  t,
}: {
  templateName: string
  language: string
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  t: T
}) {
  const { templates } = useResources()
  const row = templates.find(
    (tm) =>
      tm.name === templateName &&
      (tm.language ?? "en_US") === (language || tm.language || "en_US"),
  )
  // No selected template, or the row isn't in the loaded list (deleted /
  // legacy id) — nothing to derive slots from.
  if (!templateName || !row) return null

  const slots = collectTemplateSlots(row)
  const nothingToFill =
    slots.bodyVars.length === 0 && !slots.headerVar && slots.urlButtons.length === 0
  if (nothingToFill) {
    return (
      <p className="text-[11px] text-muted-foreground">{t("config.noTemplateVars")}</p>
    )
  }

  const body = Array.isArray(cfg.body) ? (cfg.body as string[]) : []
  const headerText = (cfg.headerText as string) ?? ""
  const buttonParams =
    cfg.buttonParams && typeof cfg.buttonParams === "object"
      ? (cfg.buttonParams as Record<string, string>)
      : {}

  const setBodyAt = (i: number, v: string) => {
    const next = [...body]
    while (next.length <= i) next.push("")
    next[i] = v
    set({ body: next })
  }

  return (
    <div className="space-y-3">
      {slots.headerVar && (
        <FieldBlock label={`Header {{1}}`}>
          <Input
            value={headerText}
            onChange={(e) => set({ headerText: e.target.value })}
            placeholder={t.raw("config.varValuePlaceholder")}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      )}

      {slots.bodyVars.map((v, i) => (
        <FieldBlock key={v} label={`Body {{${v}}}`}>
          <Input
            value={body[i] ?? ""}
            onChange={(e) => setBodyAt(i, e.target.value)}
            placeholder={t.raw("config.varValuePlaceholder")}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      ))}

      {slots.urlButtons.map((btn) => (
        <FieldBlock key={btn.index} label={`URL button "${btn.text}" — {{1}}`}>
          <Input
            value={buttonParams[String(btn.index)] ?? ""}
            onChange={(e) =>
              set({ buttonParams: { ...buttonParams, [String(btn.index)]: e.target.value } })
            }
            placeholder={t.raw("config.varValuePlaceholder")}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      ))}

      {slots.bodyVars.length > 0 && (
        <div className="rounded-md border border-border bg-background/50 p-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("config.previewLabel")}
          </p>
          <p className="whitespace-pre-wrap text-xs text-foreground">
            {previewBody(row.body_text, body)}
          </p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{t.raw("config.templateVarsHint")}</p>
    </div>
  )
}
