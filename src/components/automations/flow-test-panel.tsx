"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  FlaskConical,
  RotateCcw,
  Send,
  User,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase/client"
import type { AutomationTriggerType } from "@/types"
import type { GraphDraft } from "@/lib/automations/graph"
import { useResources } from "@/components/automations/automation-resources"
import {
  describeNode,
  emptyContext,
  resolveNext,
  simulateTriggerMatch,
  type AwaitKind,
  type BotBubble,
  type TestContact,
  type TestContext,
} from "@/lib/automations/test-walk"

// ------------------------------------------------------------
// Test-mode chat simulator (SidePanel).
//
// Walks the ACTUAL graph snapshot (drafts included) entirely
// client-side — no DB writes, no Meta sends, no external calls. Every
// send node renders a realistic bubble; every action node prints a
// "Would …" dry-run line; conditions evaluate against the tester's
// chosen contact (real, read-only, or manually-entered values). A
// persistent TEST MODE banner is always on so it can't be mistaken for
// a real conversation.
// ------------------------------------------------------------

interface FlowTestPanelProps {
  open: boolean
  onClose: () => void
  graph: GraphDraft | null
  triggerType: AutomationTriggerType
  triggerConfig: Record<string, unknown>
}

type ChatItem =
  | { role: "user"; text: string }
  | { role: "system"; tone: "info" | "dryrun" | "condition" | "warn" | "end"; text: string }
  | { role: "bot"; bubble: BotBubble; nodeId: string }

interface Paused {
  kind: AwaitKind
  resumeNodeId: string
  bubble: BotBubble | null
}

type ContactMode = "manual" | "real"

interface ContactChoice {
  id: string
  name: string | null
  phone: string
}

export function FlowTestPanel({
  open,
  onClose,
  graph,
  triggerType,
  triggerConfig,
}: FlowTestPanelProps) {
  const t = useTranslations("Automations.builder.test")
  const resources = useResources()

  const [items, setItems] = useState<ChatItem[]>([])
  const [paused, setPaused] = useState<Paused | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const [notTriggered, setNotTriggered] = useState(false)
  const [entryDraft, setEntryDraft] = useState("")
  const [answerDraft, setAnswerDraft] = useState("")

  const [contactMode, setContactMode] = useState<ContactMode>("manual")
  const [contactChoices, setContactChoices] = useState<ContactChoice[]>([])
  const [selectedContactId, setSelectedContactId] = useState("")
  const [loadingContact, setLoadingContact] = useState(false)
  // Condition-evaluation contact data. Held as STATE (so the editors can
  // render/modify it) and mirrored into ctxRef so the imperative walk
  // reads the latest snapshot at evaluate time.
  const [contact, setContact] = useState<TestContact>(() => emptyContext().contact)

  const ctxRef = useRef<TestContext>(emptyContext())
  const itemsRef = useRef<ChatItem[]>([])
  const graphRef = useRef<GraphDraft | null>(graph)

  // Keep refs in step with props outside of render (the react-hooks/refs
  // rule forbids touching `.current` during render).
  useEffect(() => {
    graphRef.current = graph
  }, [graph])
  useEffect(() => {
    ctxRef.current.contact = contact
  }, [contact])

  /** Single funnel: update both the render state and the walk snapshot. */
  const applyContact = useCallback((next: TestContact) => {
    setContact(next)
    ctxRef.current.contact = next
  }, [])

  // Lookup maps the walker uses to resolve display names.
  const nameMaps = useMemo(
    () => ({
      tagNames: Object.fromEntries(resources.tags.map((tg) => [tg.id, tg.name])),
      templates: Object.fromEntries(
        resources.templates.map((tm) => [tm.name, { body_text: tm.body_text, buttons: tm.buttons }]),
      ),
      flowNames: Object.fromEntries(resources.publishedFlows.map((f) => [f.id, f.name])),
    }),
    [resources.tags, resources.templates, resources.publishedFlows],
  )

  // The builder mounts this panel fresh on every Test click (it is
  // conditionally rendered), so initial `useState` values are the run's
  // starting state and no reset-on-open effect is needed here.

  // Load contacts (read-only, RLS-scoped) lazily for the real-contact
  // condition mode.
  useEffect(() => {
    if (!open || contactMode !== "real" || contactChoices.length > 0) return
    const supabase = createClient()
    void (async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .order("created_at", { ascending: false })
        .limit(200)
      setContactChoices((data as ContactChoice[] | null) ?? [])
    })()
  }, [open, contactMode, contactChoices.length])

  const flush = useCallback(() => {
    // Copy so React sees a new reference and re-renders.
    itemsRef.current = [...itemsRef.current]
    setItems(itemsRef.current)
  }, [])

  /** Process nodes from `startId` until a pause or a dead-end. */
  const walk = useCallback(
    (startId: string | null) => {
      const nodes = graphRef.current?.nodes ?? []
      const edges = graphRef.current?.edges ?? []
      const ctx = ctxRef.current
      let id = startId
      let guard = 0
      while (id && guard++ < 300) {
        const node = nodes.find((n) => n.id === id)
        if (!node) {
          setEnded(t("endedMissing"))
          flush()
          return
        }
        const proc = describeNode(node, ctx, nameMaps)
        if (proc.bubble) itemsRef.current.push({ role: "bot", bubble: proc.bubble, nodeId: node.id })
        for (const s of proc.system) itemsRef.current.push({ role: "system", tone: s.tone, text: s.text })
        if (proc.awaits) {
          setPaused({ kind: proc.awaits, resumeNodeId: node.id, bubble: proc.bubble })
          setEnded(null)
          flush()
          return
        }
        const nextId = resolveNext(edges, node.id, proc.nextHandle)
        if (!nextId) {
          setEnded(
            proc.nextHandle
              ? t("endedBranch", { branch: proc.nextHandle })
              : t("endedHere"),
          )
          itemsRef.current.push({ role: "system", tone: "end", text: t("endedMarker") })
          flush()
          return
        }
        id = nextId
      }
      setEnded(t("endedGuard"))
      flush()
    },
    [flush, nameMaps, t],
  )

  const startFromEntry = useCallback(() => {
    const text = entryDraft.trim()
    if (!text) return
    const nodes = graphRef.current?.nodes ?? []
    itemsRef.current.push({ role: "user", text })
    const match = simulateTriggerMatch(triggerType, triggerConfig, text)
    ctxRef.current.messageText = text
    if (!match.matched) {
      itemsRef.current.push({
        role: "system",
        tone: "warn",
        text: t("notTriggered", { reason: match.reason }),
      })
      setNotTriggered(true)
      flush()
      return
    }
    setNotTriggered(false)
    itemsRef.current.push({ role: "system", tone: "info", text: t("triggered", { reason: match.reason }) })
    const start = nodes.find((n) => n.type === "starting_step")
    if (!start) {
      itemsRef.current.push({ role: "system", tone: "warn", text: t("noStart") })
      setEnded(t("endedHere"))
      flush()
      return
    }
    setEntryDraft("")
    // Begin AFTER the starting step (it carries no bubble) — walk its next.
    const firstNext = resolveNext(graphRef.current?.edges ?? [], start.id, null)
    walk(firstNext ?? start.id)
  }, [entryDraft, flush, t, triggerConfig, triggerType, walk])

  /** Resume the walk after tester input on a paused node. */
  const resume = useCallback(
    (userText: string, mutate: (ctx: TestContext) => void) => {
      const resumeNodeId = paused?.resumeNodeId
      if (!resumeNodeId) return
      mutate(ctxRef.current)
      itemsRef.current.push({ role: "user", text: userText })
      setPaused(null)
      setAnswerDraft("")
      const nextId = resolveNext(graphRef.current?.edges ?? [], resumeNodeId, null)
      if (!nextId) {
        itemsRef.current.push({ role: "system", tone: "end", text: t("endedMarker") })
        setEnded(t("endedHere"))
        flush()
        return
      }
      walk(nextId)
    },
    [flush, paused, t, walk],
  )

  function resetRun() {
    ctxRef.current = emptyContext()
    itemsRef.current = []
    setItems([])
    setPaused(null)
    setEnded(null)
    setNotTriggered(false)
    setEntryDraft("")
    setAnswerDraft("")
    setContact(emptyContext().contact)
  }

  async function loadRealContact(cid: string) {
    setSelectedContactId(cid)
    if (!cid) {
      applyContact({ name: "", fields: {}, tagIds: [] })
      return
    }
    setLoadingContact(true)
    const supabase = createClient()
    const [{ data: c }, { data: tags }, { data: vals }] = await Promise.all([
      supabase.from("contacts").select("name, email, company").eq("id", cid).maybeSingle(),
      supabase.from("contact_tags").select("tag_id").eq("contact_id", cid),
      supabase.from("contact_custom_values").select("custom_field_id, value").eq("contact_id", cid),
    ])
    const fields: Record<string, string | number | null> = {
      name: (c as { name?: string } | null)?.name ?? null,
      email: (c as { email?: string } | null)?.email ?? null,
      company: (c as { company?: string } | null)?.company ?? null,
    }
    for (const v of (vals as { custom_field_id: string; value?: string }[] | null) ?? []) {
      fields[`custom:${v.custom_field_id}`] = v.value ?? null
    }
    applyContact({
      name: (c as { name?: string } | null)?.name ?? cid,
      fields,
      tagIds: ((tags as { tag_id: string }[] | null) ?? []).map((r) => r.tag_id),
    })
    setLoadingContact(false)
  }

  if (!open) return null

  const showEntry = items.length === 0 || notTriggered

  return (
    <div className="absolute inset-0 z-40 flex justify-end">
      {/* Dim the canvas behind the panel. */}
      <button
        type="button"
        aria-label={t("close")}
        onClick={onClose}
        className="bg-black/20 flex-1 cursor-default"
      />
      <aside className="bg-card flex h-full w-full max-w-md flex-col border-l border-border shadow-2xl">
        {/* Persistent TEST MODE banner. */}
        <div className="flex items-center justify-between bg-amber-500/15 px-4 py-2 text-amber-600 dark:text-amber-400">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide">
            <FlaskConical className="h-4 w-4" />
            {t("banner")}
          </span>
          <button
            type="button"
            onClick={resetRun}
            className="flex items-center gap-1 text-[11px] font-medium hover:underline"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("reset")}
          </button>
        </div>

        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
            <p className="text-[11px] text-muted-foreground">{t("subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t("close")}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Condition data source toggle. */}
        <div className="border-b border-border bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-[11px]">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{t("conditionSource")}:</span>
            <button
              type="button"
              onClick={() => setContactMode("manual")}
              className={cn(
                "rounded px-1.5 py-0.5 font-medium",
                contactMode === "manual"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("manual")}
            </button>
            <button
              type="button"
              onClick={() => setContactMode("real")}
              className={cn(
                "rounded px-1.5 py-0.5 font-medium",
                contactMode === "real"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("realContact")}
            </button>
          </div>
          {contactMode === "real" ? (
            <div className="mt-1.5">
              <select
                value={selectedContactId}
                onChange={(e) => void loadRealContact(e.target.value)}
                className="bg-muted w-full rounded-md border border-border px-2 py-1 text-xs text-foreground"
                disabled={loadingContact}
              >
                <option value="">{loadingContact ? t("loading") : t("pickContact")}</option>
                {contactChoices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>
              {contact.tagIds.length > 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {t("contactTags", { count: contact.tagIds.length })}
                </p>
              )}
            </div>
          ) : (
            <ManualContactEditor contact={contact} applyContact={applyContact} tags={nameMaps.tagNames} t={t} />
          )}
        </div>

        {/* Transcript */}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/20 p-4">
          {showEntry && (
            <p className="text-muted-foreground mx-auto max-w-xs pt-6 text-center text-xs">
              {t("entryHint")}
            </p>
          )}
          {items.map((item, i) => (
            <ChatRow key={i} item={item} t={t} />
          ))}
          {ended && (
            <p className="text-muted-foreground pt-1 text-center text-[11px] italic">{ended}</p>
          )}
        </div>

        {/* Interaction dock */}
        <div className="border-t border-border p-3">
          {paused ? (
            <PausedControls
              paused={paused}
              answerDraft={answerDraft}
              setAnswerDraft={setAnswerDraft}
              onResume={resume}
              onSkipForm={() => {
                const id = paused.resumeNodeId
                setPaused(null)
                itemsRef.current.push({ role: "user", text: t("formSkipped") })
                flush()
                setEnded(t("formPending"))
                void id
              }}
              t={t}
            />
          ) : ended && !showEntry ? (
            <Button variant="outline" onClick={resetRun} className="w-full gap-1.5 border-border text-foreground">
              <RotateCcw className="h-4 w-4" />
              {t("runAgain")}
            </Button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                startFromEntry()
              }}
              className="flex items-center gap-2"
            >
              <Input
                value={entryDraft}
                onChange={(e) => setEntryDraft(e.target.value)}
                placeholder={t("entryPlaceholder")}
                className="bg-muted"
              />
              <Button type="submit" disabled={!entryDraft.trim()} className="gap-1.5 shrink-0">
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">{t("send")}</span>
              </Button>
            </form>
          )}
        </div>
      </aside>
    </div>
  )
}

// ============================================================
// Transcript rendering
// ============================================================

function ChatRow({
  item,
  t,
}: {
  item: ChatItem
  t: ReturnType<typeof useTranslations>
}) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-3 py-1.5 text-sm">
          {item.text}
        </div>
      </div>
    )
  }
  if (item.role === "system") {
    const tone = item.tone
    return (
      <div className="flex justify-center">
        <p
          className={cn(
            "rounded-full px-3 py-1 text-[11px] font-medium",
            tone === "dryrun" && "bg-violet-500/10 text-violet-600 dark:text-violet-400",
            tone === "condition" && "bg-sky-500/10 text-sky-600 dark:text-sky-400",
            tone === "warn" && "bg-red-500/10 text-red-600 dark:text-red-400",
            tone === "end" && "bg-muted text-muted-foreground",
            tone === "info" && "bg-muted text-muted-foreground",
          )}
        >
          {item.text}
        </p>
      </div>
    )
  }
  // bot bubble (WhatsApp-ish inbound style)
  return (
    <div className="flex justify-start">
      <div className="bg-background max-w-[85%] rounded-2xl rounded-bl-sm border border-border px-3 py-2 text-sm shadow-sm">
        <BotBubbleView bubble={item.bubble} t={t} />
      </div>
    </div>
  )
}

function BotBubbleView({
  bubble,
  t,
}: {
  bubble: BotBubble
  t: ReturnType<typeof useTranslations>
}) {
  switch (bubble.type) {
    case "text":
    case "question":
      return (
        <div className="space-y-1">
          {bubble.type === "question" && (
            <p className="text-[10px] font-semibold uppercase text-amber-600">{t("askBadge")}</p>
          )}
          {bubble.type === "text" && bubble.header && (
            <p className="text-xs font-semibold">{bubble.header}</p>
          )}
          <p className="whitespace-pre-wrap">{bubble.text || t("emptyText")}</p>
          {bubble.type === "text" && bubble.footer && (
            <p className="text-muted-foreground text-[11px]">{bubble.footer}</p>
          )}
        </div>
      )
    case "buttons":
      return (
        <div className="space-y-1.5">
          {bubble.header && <p className="text-xs font-semibold">{bubble.header}</p>}
          <p className="whitespace-pre-wrap">{bubble.text || t("emptyText")}</p>
          <div className="mt-1 space-y-1">
            {bubble.buttons.map((b, i) => (
              <div
                key={`${b.id}-${i}`}
                className="rounded-md border border-border bg-muted/40 px-2 py-1 text-center text-xs font-medium"
              >
                {b.title || t("emptyText")}
              </div>
            ))}
          </div>
          {bubble.footer && <p className="text-muted-foreground text-[11px]">{bubble.footer}</p>}
        </div>
      )
    case "list":
      return (
        <div className="space-y-1.5">
          <p className="whitespace-pre-wrap">{bubble.text || t("emptyText")}</p>
          <div className="space-y-2">
            {bubble.sections.map((s, si) => (
              <div key={si}>
                {s.title && (
                  <p className="text-muted-foreground mb-0.5 text-[10px] uppercase">{s.title}</p>
                )}
                <div className="space-y-1">
                  {s.rows.map((r, ri) => (
                    <div
                      key={`${r.id}-${ri}`}
                      className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                    >
                      <span className="font-medium">{r.title || t("emptyText")}</span>
                      {r.description && (
                        <span className="text-muted-foreground"> — {r.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {bubble.buttonLabel && (
            <p className="text-primary text-center text-[11px] font-semibold">
              {bubble.buttonLabel}
            </p>
          )}
        </div>
      )
    case "media":
      return (
        <div className="space-y-1.5">
          {bubble.url ? (
            bubble.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={bubble.url} alt="" className="max-h-56 w-full rounded-lg object-cover" />
            ) : bubble.kind === "video" ? (
              <video src={bubble.url} controls className="max-h-56 w-full rounded-lg" />
            ) : (
              <a
                href={bubble.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary block rounded-lg border border-border bg-muted/40 px-2 py-2 text-xs font-medium"
              >
                📄 {bubble.filename || t("document")}
              </a>
            )
          ) : (
            <p className="text-muted-foreground text-xs">{t("noMedia")}</p>
          )}
          {bubble.caption && <p className="whitespace-pre-wrap">{bubble.caption}</p>}
        </div>
      )
    case "audio":
      return bubble.url ? (
        <audio src={bubble.url} controls className="w-full" />
      ) : (
        <p className="text-muted-foreground text-xs">{t("noAudio")}</p>
      )
    case "template":
      return (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase text-indigo-600">
            {t("templateBadge")} · {bubble.name || t("emptyText")} ({bubble.language})
          </p>
          <p className="whitespace-pre-wrap">{bubble.body || t("emptyText")}</p>
          {bubble.buttons.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {bubble.buttons.map((b, i) => (
                <span
                  key={i}
                  className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px]"
                >
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>
      )
    case "form":
      return (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase text-cyan-600">{t("formBadge")}</p>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-center">
            <p className="text-xs font-semibold">{bubble.flowName}</p>
            <p className="text-muted-foreground text-[10px]">{t("formTapHint")}</p>
          </div>
        </div>
      )
    case "payment":
      return (
        <p className="whitespace-pre-wrap">
          {t("paymentText", {
            amount: String(bubble.amount),
            currency: bubble.currency,
          })}
          {bubble.description ? ` — ${bubble.description}` : ""}
        </p>
      )
    default:
      return null
  }
}

// ============================================================
// Paused-input controls
// ============================================================

function PausedControls({
  paused,
  answerDraft,
  setAnswerDraft,
  onResume,
  onSkipForm,
  t,
}: {
  paused: Paused
  answerDraft: string
  setAnswerDraft: (v: string) => void
  onResume: (userText: string, mutate: (ctx: TestContext) => void) => void
  onSkipForm: () => void
  t: ReturnType<typeof useTranslations>
}) {
  if (paused.kind === "buttons" && paused.bubble?.type === "buttons") {
    return (
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-[11px]">{t("tapPrompt")}</p>
        <div className="grid grid-cols-1 gap-1.5">
          {paused.bubble.buttons.map((b, i) => (
            <Button
              key={`${b.id}-${i}`}
              variant="outline"
              className="w-full border-border text-foreground"
              onClick={() =>
                onResume(b.title || b.id, (ctx) => {
                  ctx.messageText = b.title || b.id
                })
              }
            >
              {b.title || t("emptyText")}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  if (paused.kind === "list" && paused.bubble?.type === "list") {
    const rows = paused.bubble.sections.flatMap((s) => s.rows)
    return (
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-[11px]">{t("tapPrompt")}</p>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {rows.map((r, i) => (
            <Button
              key={`${r.id}-${i}`}
              variant="outline"
              className="w-full justify-start border-border text-foreground"
              onClick={() =>
                onResume(r.title || r.id, (ctx) => {
                  ctx.messageText = r.title || r.id
                })
              }
            >
              {r.title || t("emptyText")}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  if (paused.kind === "question" && paused.bubble?.type === "question") {
    const variable = paused.bubble.variable
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const val = answerDraft.trim()
          if (!val) return
          onResume(val, (ctx) => {
            ctx.messageText = val
            if (variable) ctx.vars[variable] = val
          })
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={answerDraft}
          onChange={(e) => setAnswerDraft(e.target.value)}
          placeholder={variable ? t("answerPlaceholderVar", { variable }) : t("answerPlaceholder")}
          className="bg-muted"
          autoFocus
        />
        <Button type="submit" disabled={!answerDraft.trim()} className="gap-1.5 shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    )
  }

  if (paused.kind === "form") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={() =>
            onResume(t("formSubmitted"), (ctx) => {
              // Dry-run submit — no field writes; walk continues down the
              // single outgoing ("Form Completed") edge.
              void ctx
            })
          }
          className="gap-1.5"
        >
          <Send className="h-4 w-4" />
          {t("formSubmit")}
        </Button>
        <Button variant="outline" onClick={onSkipForm} className="border-border text-foreground">
          {t("formDontSubmit")}
        </Button>
      </div>
    )
  }

  return null
}

// ============================================================
// Manual condition-data editor (used when no real contact is picked).
// ============================================================

function ManualContactEditor({
  contact,
  applyContact,
  tags,
  t,
}: {
  contact: TestContact
  applyContact: (next: TestContact) => void
  tags: Record<string, string>
  t: ReturnType<typeof useTranslations>
}) {
  const cols = Object.keys(contact.fields)
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-muted-foreground text-[10px]">{t("manualHint")}</p>
      <div className="flex flex-wrap gap-1">
        {Object.entries(tags).map(([id, name]) => {
          const on = contact.tagIds.includes(id)
          return (
            <button
              key={id}
              type="button"
              onClick={() =>
                applyContact({
                  ...contact,
                  tagIds: on ? contact.tagIds.filter((x) => x !== id) : [...contact.tagIds, id],
                })
              }
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                on
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
                  : "border-border text-muted-foreground",
              )}
            >
              {name}
            </button>
          )
        })}
      </div>
      <div className="space-y-1">
        {cols.map((col) => (
          <ManualFieldRow key={col} col={col} contact={contact} applyContact={applyContact} t={t} />
        ))}
        <AddFieldRow contact={contact} applyContact={applyContact} t={t} />
      </div>
    </div>
  )
}

function ManualFieldRow({
  col,
  contact,
  applyContact,
  t,
}: {
  col: string
  contact: TestContact
  applyContact: (next: TestContact) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground w-24 shrink-0 truncate text-[10px]" title={col}>
        {col}
      </span>
      <Input
        defaultValue={String(contact.fields[col] ?? "")}
        onBlur={(e) => {
          const v = e.target.value
          const fields = { ...contact.fields }
          if (v === "") delete fields[col]
          else fields[col] = v
          applyContact({ ...contact, fields })
        }}
        placeholder={t("fieldValue")}
        className="bg-muted h-7 px-2 text-[11px]"
      />
    </div>
  )
}

function AddFieldRow({
  contact,
  applyContact,
  t,
}: {
  contact: TestContact
  applyContact: (next: TestContact) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [col, setCol] = useState("")
  return (
    <div className="flex items-center gap-1">
      <Input
        value={col}
        onChange={(e) => setCol(e.target.value)}
        placeholder={t("fieldName")}
        className="bg-muted h-7 px-2 text-[11px]"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 border-border px-2 text-[11px]"
        onClick={() => {
          const key = col.trim()
          if (!key || key in contact.fields) {
            setCol("")
            return
          }
          applyContact({ ...contact, fields: { ...contact.fields, [key]: "" } })
          setCol("")
        }}
      >
        {t("addField")}
      </Button>
    </div>
  )
}