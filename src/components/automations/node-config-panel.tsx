"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2, Trash2, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { InteractiveBuilder } from "@/components/interactive/interactive-builder"
import {
  asInteractiveCfg,
  AgentSelect,
  ContactFieldSelect,
  DealPipelineFields,
  FieldBlock,
  SELECT_CLASS,
  SendTemplateFields,
  TagSelect,
  TemplateVariablesFields,
  toCfg,
  useResources,
} from "@/components/automations/automation-resources"
import { ACCENT_CLASS, isLegacyOnlyType, nodeTitle } from "@/components/automations/automation-canvas"
import { AUTOMATION_NODE_META, type AutomationNodeRow } from "@/lib/automations/graph-types"
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media"
import type {
  AutomationTriggerType,
  KeywordMatchTriggerConfig,
  PublishedFlowOption,
} from "@/types"

// ------------------------------------------------------------
// Node settings panel — the card a clicked node opens. Hosts:
//   * starting_step  → the trigger form (ex-TriggerCard body)
//   * palette types  → the per-type config forms from the spec
//   * legacy types   → the exact step editors the vertical builder
//     used, extracted (not rewritten) so migrated automations stay
//     editable in place.
// The shell owns persistence: edits stream back through
// onConfigChange (debounced PATCH in edit mode).
// ------------------------------------------------------------

const TRIGGER_OPTIONS: { value: AutomationTriggerType }[] = [
  { value: "new_message_received" },
  { value: "first_inbound_message" },
  { value: "keyword_match" },
  { value: "interactive_reply" },
  { value: "new_contact_created" },
  { value: "conversation_assigned" },
  { value: "tag_added" },
  { value: "time_based" },
]

// The chat-media bucket is the app's existing upload path (inbox
// composer); automations reuse it rather than minting a new storage
// surface. Literal here (not imported from the composer module) to
// avoid pulling that component tree into the builder bundle.
const AUTOMATION_MEDIA_BUCKET = "chat-media"

export interface NodeConfigPanelProps {
  /** The selected graph row; `null` closes the sheet. */
  node: AutomationNodeRow | null
  triggerType: AutomationTriggerType
  triggerConfig: Record<string, unknown>
  onTriggerTypeChange: (t: AutomationTriggerType) => void
  onTriggerConfigChange: (c: Record<string, unknown>) => void
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void
  onDelete: (nodeId: string) => void
  onClose: () => void
}

export function NodeConfigPanel(props: NodeConfigPanelProps) {
  const { node } = props
  const t = useTranslations("Automations.builder")
  const open = node !== null

  return (
    <Sheet open={open} onOpenChange={(v) => !v && props.onClose()}>
      <SheetContent
        side="right"
        className="border-border bg-popover flex w-full flex-col gap-0 border-l p-0 sm:max-w-md"
      >
        {node && (
          // Remount per node so local drafts (JSON textareas, keyword
          // strings, upload state) never bleed across selections.
          <PanelBody key={node.id} {...props} node={node} onCfgReplace={(cfg) => props.onConfigChange(node.id, cfg)} t={t} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function PanelBody({
  node,
  triggerType,
  triggerConfig,
  onTriggerTypeChange,
  onTriggerConfigChange,
  onCfgReplace,
  onDelete,
  t,
}: NodeConfigPanelProps & { node: AutomationNodeRow; onCfgReplace: (cfg: Record<string, unknown>) => void; t: ReturnType<typeof useTranslations> }) {
  const meta = AUTOMATION_NODE_META[node.type]
  const Icon = meta?.icon
  const hue = ACCENT_CLASS[meta?.color ?? ""]
  const isStart = node.type === "starting_step"

  const set = (patch: Record<string, unknown>) =>
    onCfgReplace({ ...node.config, ...patch })

  return (
    <>
      <SheetHeader className="border-border flex-row items-center gap-3 space-y-0 border-b px-5 py-4">
        {Icon && (
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${hue?.chip ?? "bg-muted text-muted-foreground"}`}
            aria-hidden
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-sm font-semibold text-foreground">
            {nodeTitle(t, node.type)}
          </SheetTitle>
          <SheetDescription className="mt-0.5 truncate text-xs text-muted-foreground">
            {isStart
              ? t("nodeTypes.starting_step.description")
              : isLegacyOnlyType(node.type)
                ? ""
                : t(`nodeTypes.${node.type}.description`)}
          </SheetDescription>
        </div>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {isStart ? (
          <TriggerFields
            type={triggerType}
            config={triggerConfig}
            onTypeChange={onTriggerTypeChange}
            onConfigChange={onTriggerConfigChange}
            t={t}
          />
        ) : (
          <NodeConfigFields node={node} set={set} replace={onCfgReplace} t={t} />
        )}
      </div>

      {!isStart && (
        <SheetFooter className="border-border border-t px-5 py-3 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(node.id)}
            className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("delete")}
          </Button>
        </SheetFooter>
      )}
    </>
  )
}

// ------------------------------------------------------------
// starting_step — the trigger form (ex-TriggerCard expanded body)
// ------------------------------------------------------------

function TriggerFields({
  type,
  config,
  onTypeChange,
  onConfigChange,
  t,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <>
      <FieldBlock label={t("triggerType")}>
        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
          className={SELECT_CLASS}
        >
          {TRIGGER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(`triggers.${o.value}.label`)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t(`triggers.${type}.hint`)}
        </p>
      </FieldBlock>
      {type === "keyword_match" && (
        <KeywordMatchConfig
          config={config as unknown as KeywordMatchTriggerConfig}
          onChange={onConfigChange}
          t={t}
        />
      )}
      {type === "interactive_reply" && (
        <InteractiveReplyConfig config={config} onChange={onConfigChange} t={t} />
      )}
      {type === "tag_added" && (
        <FieldBlock label="Tag">
          <TagSelect
            value={(config.tag_id as string) ?? ""}
            onChange={(v) => onConfigChange({ ...config, tag_id: v })}
            t={t}
          />
        </FieldBlock>
      )}
      {type === "time_based" && (
        <FieldBlock label={t("schedule")}>
          <Input
            placeholder={t("schedulePlaceholder")}
            value={(config.schedule as string) ?? ""}
            onChange={(e) => onConfigChange({ ...config, schedule: e.target.value })}
            className="bg-muted text-foreground"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t("scheduleHint")}</p>
        </FieldBlock>
      )}
    </>
  )
}

// The two list-style trigger editors, extracted verbatim from the
// vertical builder (local-draft-then-commit so commas + spaces
// survive keystrokes).

function KeywordMatchConfig({
  config,
  onChange,
  t,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const keywords = config?.keywords ?? []
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays — leaving it untouched
  // would omit match_type and activation validation rejects that.
  // Seed once on mount; the component remounts on trigger-type change.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <>
      <FieldBlock label={t("keywords")}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t("keywordsHint")}
          className="bg-muted text-foreground"
        />
      </FieldBlock>
      <FieldBlock label={t("config.matchType")}>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) =>
            onChange({
              ...config,
              match_type: e.target.value as "exact" | "contains" | "word",
            })
          }
          className={SELECT_CLASS}
        >
          <option value="contains">{t("config.matchContains")}</option>
          <option value="word">{t("config.matchWord")}</option>
          <option value="exact">{t("config.matchExact")}</option>
        </select>
        {config?.match_type === "word" && (
          <p className="mt-1 text-xs text-muted-foreground">{t("config.matchWordHint")}</p>
        )}
      </FieldBlock>
    </>
  )
}

function InteractiveReplyConfig({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const ids = (config?.reply_ids as string[] | undefined) ?? []
  const [draft, setDraft] = useState(ids.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, reply_ids: parsed })
  }

  return (
    <FieldBlock label={t("replyIds")}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        placeholder={t("replyIdsHint")}
        className="bg-muted font-mono text-foreground"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">{t("replyIdsHelp")}</p>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Per-type config dispatcher: palette forms first, then the
// legacy step editors (decompiled + migrated step trees carry the
// legacy type names verbatim).
// ------------------------------------------------------------

function NodeConfigFields({
  node,
  set,
  replace,
  t,
}: {
  node: AutomationNodeRow
  set: (patch: Record<string, unknown>) => void
  replace: (cfg: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const cfg = node.config
  switch (node.type) {
    // ---- Messages palette ----
    case "text_button":
    case "list":
    case "send_buttons":
    case "send_list":
      // The whole node config IS the interactive payload; the shared
      // builder edits it in place (and enforces Meta's limits + preview).
      return (
        <InteractiveBuilder
          value={asInteractiveCfg(cfg)}
          onChange={(payload) => replace(toCfg(payload))}
        />
      )
    case "media":
      return <MediaFields cfg={cfg} set={set} t={t} />
    case "audio":
      return <AudioFields cfg={cfg} set={set} t={t} />
    case "template":
    case "send_template":
      return (
        <>
          <SendTemplateFields
            templateName={(cfg.template_name as string) ?? ""}
            language={(cfg.language as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <TemplateVariablesFields
            templateName={(cfg.template_name as string) ?? ""}
            language={(cfg.language as string) ?? ""}
            cfg={cfg}
            set={set}
            t={t}
          />
        </>
      )
    case "ask_question":
      return (
        <>
          <FieldBlock label={t("config.questionLabel")}>
            <Textarea
              value={(cfg.text as string) ?? ""}
              onChange={(e) => set({ text: e.target.value })}
              placeholder={t("config.placeholderQuestion")}
              className="min-h-24 bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.variableLabel")}>
            <Input
              value={(cfg.variable as string) ?? ""}
              onChange={(e) => set({ variable: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
              placeholder={t("config.variablePlaceholder")}
              className="bg-muted font-mono text-foreground"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{t.raw("config.variableHelp")}</p>
          </FieldBlock>
        </>
      )
    case "whatsapp_form":
      return <WhatsAppFormFields cfg={cfg} set={set} t={t} />
    case "payment":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <FieldBlock label={t("config.amountLabel")}>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={String(cfg.amount ?? 0)}
                onChange={(e) => set({ amount: Math.max(0, Number(e.target.value)) })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
            <FieldBlock label={t("config.currencyLabel")}>
              <Input
                value={(cfg.currency as string) ?? ""}
                onChange={(e) => set({ currency: e.target.value.toUpperCase().slice(0, 3) })}
                placeholder="INR"
                className="bg-muted font-mono uppercase text-foreground"
              />
            </FieldBlock>
          </div>
          <FieldBlock label={t("config.descriptionLabel")}>
            <Input
              value={(cfg.description as string) ?? ""}
              onChange={(e) => set({ description: e.target.value })}
              placeholder={t("config.placeholderDescription")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <p className="text-[11px] text-muted-foreground">{t("config.paymentHint")}</p>
        </>
      )
    // ---- Actions palette ----
    case "save_attribute":
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("config.fieldLabel")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
              t={t}
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder={t.raw("config.placeholderValue")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("config.tagLabel")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
            t={t}
          />
        </FieldBlock>
      )
    case "google_sheet":
      return (
        <>
          <FieldBlock label={t("config.spreadsheetLabel")}>
            <Input
              value={(cfg.spreadsheet as string) ?? ""}
              onChange={(e) => set({ spreadsheet: e.target.value })}
              placeholder={t("config.placeholderSpreadsheet")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <PairRows
            label={t("config.mappingLabel")}
            firstHeader={t("config.columnLabel")}
            secondHeader={t("config.valueLabel")}
            rows={(cfg.mapping as { column: string; value: string }[]) ?? []}
            firstKey="column"
            secondKey="value"
            onChange={(rows) => set({ mapping: rows })}
          />
          <p className="text-[11px] text-muted-foreground">{t("config.googleSheetHint")}</p>
        </>
      )
    case "meta_capi":
      return (
        <>
          <FieldBlock label={t("config.eventTypeLabel")}>
            <Input
              value={(cfg.event_type as string) ?? ""}
              onChange={(e) => set({ event_type: e.target.value })}
              placeholder="Purchase"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <PairRows
            label={t("config.customDataLabel")}
            firstHeader={t("config.keyLabel")}
            secondHeader={t("config.valueLabel")}
            rows={(cfg.custom_data as { key: string; value: string }[]) ?? []}
            firstKey="key"
            secondKey="value"
            onChange={(rows) => set({ custom_data: rows })}
          />
          <p className="text-[11px] text-muted-foreground">{t("config.metaCapiHint")}</p>
        </>
      )
    case "time_delay":
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("config.amountLabel")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.unitLabel")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="minutes">{t("config.units.minutes")}</option>
              <option value="hours">{t("config.units.hours")}</option>
              <option value="days">{t("config.units.days")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "webhook":
      return (
        <>
          <FieldBlock label={t("config.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://…"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.methodLabel")}>
            <select
              value={(cfg.method as string) ?? "POST"}
              onChange={(e) => set({ method: e.target.value })}
              className={SELECT_CLASS}
            >
              {["GET", "POST", "PUT", "DELETE"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </FieldBlock>
          <JsonDictField
            label={t("config.headersLabel")}
            value={(cfg.headers as Record<string, string>) ?? {}}
            onChange={(v) => set({ headers: v })}
          />
          <FieldBlock label={t("config.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.payload as string) ?? ""}
              onChange={(e) => set({ payload: e.target.value })}
              placeholder={t.raw("config.placeholderBody")}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "send_webhook":
      // Legacy shape — url + body_template, exactly as the vertical
      // builder edited it (no method/headers fields existed).
      return (
        <>
          <FieldBlock label={t("config.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "condition":
      return <ConditionFields cfg={cfg} set={set} t={t} />
    // ---- Legacy-only types ----
    case "send_message":
      return (
        <FieldBlock label={t("config.messageText")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t("config.placeholderMessageText")}
            className="min-h-24 bg-muted text-foreground"
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("config.modeLabel")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="round_robin">{t("config.modes.round_robin")}</option>
              <option value="specific">{t("config.modes.specific")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("config.agentLabel")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
                t={t}
              />
            </FieldBlock>
          )}
        </>
      )
    case "create_deal":
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ""}
            stageId={(cfg.stage_id as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <FieldBlock label={t("config.titleLabel")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          {t("config.closeConversationHint")}
        </p>
      )
    case "starting_step":
      return null
    default:
      return null
  }
}

// ------------------------------------------------------------
// Media / Audio / WhatsApp Form / Condition sub-forms
// ------------------------------------------------------------

function MediaFields({
  cfg,
  set,
  t,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const kind = (cfg.media_kind as string) ?? "image"
  return (
    <>
      <FieldBlock label={t("config.mediaKindLabel")}>
        <select
          value={kind}
          onChange={(e) => set({ media_kind: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="image">{t("config.kinds.image")}</option>
          <option value="video">{t("config.kinds.video")}</option>
          <option value="document">{t("config.kinds.document")}</option>
        </select>
      </FieldBlock>
      <UploadRow
        accept={kind === "image" ? "image/*" : kind === "video" ? "video/*" : ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"}
        onUploaded={(publicUrl, filename) =>
          // One patch for both fields so the panel never renders a
          // half-uploaded state.
          set({ url: publicUrl, ...(kind === "document" ? { filename } : {}) })
        }
        t={t}
      />
      <FieldBlock label={t("config.urlLabel")}>
        <Input
          value={(cfg.url as string) ?? ""}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://…"
          className="bg-muted text-foreground"
        />
      </FieldBlock>
      <FieldBlock label={t("config.captionLabel")}>
        <Textarea
          value={(cfg.caption as string) ?? ""}
          onChange={(e) => set({ caption: e.target.value })}
          placeholder={t("config.placeholderCaption")}
          className="min-h-16 bg-muted text-foreground"
        />
      </FieldBlock>
      {kind === "document" && (
        <FieldBlock label={t("config.filenameLabel")}>
          <Input
            value={(cfg.filename as string) ?? ""}
            onChange={(e) => set({ filename: e.target.value })}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      )}
    </>
  )
}

function AudioFields({
  cfg,
  set,
  t,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <>
      <UploadRow accept="audio/*" onUploaded={(publicUrl) => set({ url: publicUrl })} t={t} />
      <FieldBlock label={t("config.urlLabel")}>
        <Input
          value={(cfg.url as string) ?? ""}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://…"
          className="bg-muted text-foreground"
        />
      </FieldBlock>
    </>
  )
}

/** Hidden-file-input upload button backed by the app's existing
 *  account-scoped storage helper (same path the chat composer and the
 *  flows canvas use). */
function UploadRow({
  accept,
  onUploaded,
  t,
}: {
  accept: string
  onUploaded: (publicUrl: string, filename: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MEDIA_MAX_BYTES) {
      toast.error(t("canvas.fileTooLarge", { max: String(Math.round(MEDIA_MAX_BYTES / (1024 * 1024))) }))
      return
    }
    setUploading(true)
    try {
      const { publicUrl } = await uploadAccountMedia(AUTOMATION_MEDIA_BUCKET, file)
      onUploaded(publicUrl, file.name)
      toast.success(t("canvas.uploaded"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("canvas.uploadFailed"))
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
        {uploading ? t("canvas.uploading") : t("canvas.upload")}
      </Button>
    </div>
  )
}

function WhatsAppFormFields({
  cfg,
  set,
  t,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { publishedFlows } = useResources()
  const value = (cfg.flow_id as string) ?? ""

  // Choices come only from the Forms page — no manual flow-id entry. A
  // saved flow that has since been deleted still shows as a labelled
  // option so editing an existing automation doesn't silently drop it.
  const selected = publishedFlows.find((f: PublishedFlowOption) => f.id === value)
  return (
    <FieldBlock label={t("config.flowLabel")}>
      <select
        value={value}
        onChange={(e) => set({ flow_id: e.target.value })}
        className={SELECT_CLASS}
        disabled={publishedFlows.length === 0}
      >
        <option value="">{t("config.selectFlow")}</option>
        {publishedFlows.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        {value && !selected && (
          <option value={value}>{t("config.unknownFlow", { id: value })}</option>
        )}
      </select>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {publishedFlows.length === 0 ? t("config.noPublishedFlows") : t("config.flowHelp")}
      </p>
    </FieldBlock>
  )
}

function ConditionFields({
  cfg,
  set,
  t,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <>
      <FieldBlock label={t("config.subjectLabel")}>
        <select
          value={(cfg.subject as string) ?? "tag_presence"}
          onChange={(e) => set({ subject: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="tag_presence">{t("config.subjects.tag_presence")}</option>
          <option value="contact_field">{t("config.subjects.contact_field")}</option>
          <option value="message_content">{t("config.subjects.message_content")}</option>
          <option value="time_of_day">{t("config.subjects.time_of_day")}</option>
        </select>
      </FieldBlock>
      <FieldBlock label={t("config.operandLabel")}>
        <Input
          placeholder={
            cfg.subject === "time_of_day"
              ? t("config.placeholderTime")
              : cfg.subject === "contact_field"
                ? t("config.placeholderContact")
                : cfg.subject === "tag_presence"
                  ? t("config.placeholderTag")
                  : ""
          }
          value={(cfg.operand as string) ?? ""}
          onChange={(e) => set({ operand: e.target.value })}
          className="bg-muted text-foreground"
        />
      </FieldBlock>
      {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
        <FieldBlock label={t("config.valueLabel")}>
          <Input
            value={(cfg.value as string) ?? ""}
            onChange={(e) => set({ value: e.target.value })}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      )}
      <p className="text-[11px] text-muted-foreground">{t("canvas.conditionHint")}</p>
    </>
  )
}

// ------------------------------------------------------------
// Repeating key/value rows + JSON object textarea
// ------------------------------------------------------------

function PairRows({
  label,
  firstHeader,
  secondHeader,
  rows,
  firstKey,
  secondKey,
  onChange,
}: {
  label: string
  firstHeader: string
  secondHeader: string
  rows: Record<string, string>[]
  firstKey: string
  secondKey: string
  onChange: (rows: Record<string, string>[]) => void
}) {
  const t = useTranslations("Automations.builder")
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center justify-between">
        <label className="block text-xs font-medium text-muted-foreground">{label}</label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...rows, { [firstKey]: "", [secondKey]: "" }])}
        >
          + {t("config.addRow")}
        </Button>
      </div>
      {rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">—</p>
      )}
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={row[firstKey] ?? ""}
              placeholder={firstHeader}
              onChange={(e) =>
                onChange(rows.map((r, j) => (j === i ? { ...r, [firstKey]: e.target.value } : r)))
              }
              className="bg-muted text-foreground"
            />
            <Input
              value={row[secondKey] ?? ""}
              placeholder={secondHeader}
              onChange={(e) =>
                onChange(rows.map((r, j) => (j === i ? { ...r, [secondKey]: e.target.value } : r)))
              }
              className="bg-muted text-foreground"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="remove"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="shrink-0 text-muted-foreground hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Object-typed config fields (template variables, webhook headers)
 *  edited as JSON text with commit-on-blur semantics — invalid JSON
 *  never reaches the node config. */
function JsonDictField({
  label,
  value,
  onChange,
}: {
  label: string
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2))
  const lastEmitted = useRef(value)

  // Re-seed only when the stored object actually changed elsewhere
  // (node switch is handled by the panel's per-node remount key).
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      setDraft(JSON.stringify(value, null, 2))
    }
  }, [value])

  function commit() {
    const trimmed = draft.trim()
    if (trimmed === "") {
      lastEmitted.current = {}
      onChange({})
      return
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed as Record<string, unknown>).some((v) => typeof v !== "string")
      ) {
        throw new Error("not a string map")
      }
      const next = parsed as Record<string, string>
      lastEmitted.current = next
      onChange(next)
    } catch {
      toast.error("Invalid JSON — expected {\"key\": \"value\"}")
    }
  }

  return (
    <FieldBlock label={label}>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="min-h-20 bg-muted font-mono text-xs text-foreground"
      />
    </FieldBlock>
  )
}
