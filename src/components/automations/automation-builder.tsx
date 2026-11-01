"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ArrowLeft, Loader2, Send, TriangleAlert, X, Zap } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { AutomationTriggerType } from "@/types"
import {
  blankPaletteConfig,
  type AutomationEdgeRow,
  type AutomationNodeRow,
  type AutomationNodeType,
  type PaletteNodeType,
} from "@/lib/automations/graph-types"
import {
  decompileStepsToGraph,
  wouldCreateCycle,
  type GraphDraft,
} from "@/lib/automations/graph"
import { ResourcesProvider } from "@/components/automations/automation-resources"
import {
  AutomationCanvas,
  type CanvasDropTarget,
} from "@/components/automations/automation-canvas"
import { SelectActionDialog } from "@/components/automations/select-action-dialog"
import { NodeConfigPanel } from "@/components/automations/node-config-panel"
import { FlowTestPanel } from "@/components/automations/flow-test-panel"

// ------------------------------------------------------------
// Automations builder — React-Flow canvas shell (n8n-style).
//
// The node/edge GRAPH is the authoring source of truth; the server
// recompiles it into the automation_steps tree the engine runs on
// every graph mutation. Two sync modes:
//   * Edit (an id exists): every canvas mutation mirrors to the
//     /api/automations/[id]/nodes|edges endpoints as it happens
//     (config PATCHes debounced 300ms); Save only writes the
//     top-level fields + activation.
//   * Create (/automations/new): the graph lives purely in state and
//     is flushed once through POST /api/automations { graph }.
// The top bar, toasts, and activation-issue surfacing are unchanged
// from the vertical builder so older muscle memory still works.
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  /** Legacy vertical-builder payload — used as the graph source when
   *  the automation has no graph rows yet (template seeds, pre-canvas
   *  rows on the create path). */
  steps: BuilderStep[]
  /** Graph rows from GET /api/automations/[id] (edit mode). */
  nodes?: AutomationNodeRow[]
  edges?: AutomationEdgeRow[]
}

interface TopFields {
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
}

function uid(): string {
  return (
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  )
}

/** Non-2xx API response, carrying the {error, issues} activation shape. */
class GraphApiError extends Error {
  issues?: { path?: string; message?: string }[]
  constructor(message: string, issues?: { path?: string; message?: string }[]) {
    super(message)
    this.issues = issues
  }
}

/** One item from the publish gate's structured result. `path` points at
 *  the offending node (`nodes.<id>` or a `nodes.<id>.<field>` sub-path)
 *  so clicking the row can reveal that node on the canvas. */
export interface PublishIssue {
  path: string
  message: string
  severity?: "error" | "warning"
}

/** Extract the node id from an issue path ("nodes.<id>.template_name"
 *  → "<id>"), or null when the issue isn't tied to a specific node
 *  (e.g. graph-wide trigger / step-tree problems). */
function nodeIdFromPath(path: string): string | null {
  const m = /^nodes\.([^.]+)/.exec(path)
  return m ? m[1] : null
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new GraphApiError(
      (json as { error?: string }).error ?? `request failed (${res.status})`,
      (json as { issues?: { path?: string; message?: string }[] }).issues,
    )
  }
  return json as T
}

/** Surface {error, issues} responses the way the vertical builder's
 *  save() did: first concrete issue in the title, its path as the
 *  description — so the activation toast pattern stays familiar. */
function useIssueToast() {
  const t = useTranslations("Automations.builder")
  return (err: unknown) => {
    if (err instanceof GraphApiError && err.issues?.[0]?.message) {
      const first = err.issues[0]
      toast.error(first.message, {
        description: first.path ? `at ${first.path}` : undefined,
      })
    } else {
      toast.error(
        err instanceof Error && err.message ? err.message : t("canvas.syncError"),
      )
    }
  }
}

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const t = useTranslations("Automations.builder")
  const isEditing = !!initial.id
  const toastIssue = useIssueToast()

  const [top, setTop] = useState<TopFields>({
    name: initial.name,
    description: initial.description,
    trigger_type: initial.trigger_type,
    trigger_config: initial.trigger_config,
    is_active: initial.is_active,
  })

  // Graph rows hydrate from GET when present; otherwise the seeded /
  // legacy step tree is decompiled into a laid-out graph client-side
  // (decompileStepsToGraph is pure + client-safe).
  const [graph, setGraph] = useState<GraphDraft>(() =>
    initial.nodes && initial.nodes.length > 0
      ? { nodes: initial.nodes, edges: initial.edges ?? [] }
      : decompileStepsToGraph(initial.steps),
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<CanvasDropTarget | null>(null)
  const [saving, setSaving] = useState(false)

  // Publish state: the in-flight flag, the structured results returned
  // by /publish (errors block, warnings are advisory), and a focus
  // signal that pans the canvas onto a node when one of its errors is
  // clicked.
  const [publishing, setPublishing] = useState(false)
  const [results, setResults] = useState<{
    errors: PublishIssue[]
    warnings: PublishIssue[]
  } | null>(null)
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null)

  // Test-mode panel: a client-side dry-run walk of the graph. Opening it
  // captures the current graph snapshot so edits on the canvas mid-test
  // don't shift the run out from under the tester.
  const [testing, setTesting] = useState(false)
  const [testGraph, setTestGraph] = useState<GraphDraft | null>(null)

  // Debounced config PATCHes per node — keystrokes collapse into one
  // write 300ms after typing stops.
  const configTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = configTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const graphRef = useRef(graph)
  graphRef.current = graph

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  )

  // ------------------------------------------------------------
  // Local graph mutators (optimistic; server mirror where editing)
  // ------------------------------------------------------------

  function patchNodeLocal(id: string, patch: Partial<AutomationNodeRow>) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }))
  }

  function removeNodesLocal(ids: Set<string>) {
    setGraph((g) => ({
      nodes: g.nodes.filter((n) => !ids.has(n.id)),
      edges: g.edges.filter(
        (e) => !ids.has(e.source_node_id) && !ids.has(e.target_node_id),
      ),
    }))
  }

  async function refreshGraph() {
    if (!isEditing) return
    try {
      const json = await api<{ nodes: AutomationNodeRow[]; edges: AutomationEdgeRow[] }>(
        `/api/automations/${initial.id}/nodes`,
      )
      setGraph({ nodes: json.nodes ?? [], edges: json.edges ?? [] })
    } catch (err) {
      toastIssue(err)
    }
  }

  // ------------------------------------------------------------
  // Canvas callbacks
  // ------------------------------------------------------------

  function handleNodeDragStop(id: string, x: number, y: number) {
    patchNodeLocal(id, { position_x: x, position_y: y })
    if (isEditing) {
      void api(`/api/automations/${initial.id}/nodes/${id}`, "PATCH", {
        position_x: x,
        position_y: y,
      }).catch(toastIssue)
    }
  }

  function handleConfigChange(id: string, config: Record<string, unknown>) {
    patchNodeLocal(id, { config })
    if (!isEditing) return
    const timers = configTimers.current
    const pending = timers.get(id)
    if (pending) clearTimeout(pending)
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        void api<{ node: AutomationNodeRow }>(
          `/api/automations/${initial.id}/nodes/${id}`,
          "PATCH",
          { config },
        ).catch(async (err) => {
          toastIssue(err)
          // Server rejected the edit — snap the panel back to truth.
          await refreshGraph()
        })
      }, 300),
    )
  }

  function handleConnect(params: {
    source: string
    target: string
    handle: "yes" | "no" | null
  }) {
    const { source, target, handle } = params
    if (source === target) return
    const { edges, nodes } = graphRef.current
    const targetType = nodes.find((n) => n.id === target)?.type
    if (targetType === "starting_step") return
    if (wouldCreateCycle(edges, source, target)) {
      toast.error(t("canvas.loopError"))
      return
    }
    // A node may only have one incoming connection (compile semantics)
    // — re-wiring a target replaces its existing edge.
    const stale = edges.filter((e) => e.target_node_id === target)
    if (!isEditing) {
      setGraph((g) => ({
        nodes: g.nodes,
        edges: [
          ...g.edges.filter((e) => e.target_node_id !== target),
          {
            id: uid(),
            automation_id: "",
            account_id: "",
            source_node_id: source,
            target_node_id: target,
            source_handle: handle,
          },
        ],
      }))
      return
    }
    void (async () => {
      try {
        for (const e of stale) {
          await api(`/api/automations/${initial.id}/edges/${e.id}`, "DELETE")
        }
        const json = await api<{ edge: AutomationEdgeRow }>(
          `/api/automations/${initial.id}/edges`,
          "POST",
          { source_node_id: source, target_node_id: target, source_handle: handle },
        )
        setGraph((g) => ({
          nodes: g.nodes,
          edges: [...g.edges.filter((e) => e.target_node_id !== target), json.edge],
        }))
      } catch (err) {
        toastIssue(err)
        await refreshGraph()
      }
    })()
  }

  /** "Select Action" pick: create the node at the drop point, wired to
   *  the handle the drag started from. */
  async function createNodeAtDrop(type: PaletteNodeType) {
    const drop = dropTarget
    setDropTarget(null)
    if (!drop) return
    const config = blankPaletteConfig(type)

    if (!isEditing) {
      const id = uid()
      const node: AutomationNodeRow = {
        id,
        automation_id: "",
        account_id: "",
        type,
        config,
        position_x: Math.round(drop.x),
        position_y: Math.round(drop.y),
      }
      setGraph((g) => ({
        nodes: [...g.nodes, node],
        edges: drop.sourceNodeId
          ? [
              ...g.edges.filter((e) => e.target_node_id !== id),
              {
                id: uid(),
                automation_id: "",
                account_id: "",
                source_node_id: drop.sourceNodeId,
                target_node_id: id,
                source_handle: drop.sourceHandle,
              },
            ]
          : g.edges,
      }))
      setSelectedId(id)
      return
    }

    try {
      const json = await api<{ node: AutomationNodeRow }>(
        `/api/automations/${initial.id}/nodes`,
        "POST",
        {
          type,
          config,
          position_x: Math.round(drop.x),
          position_y: Math.round(drop.y),
        },
      )
      const node = json.node
      setGraph((g) => ({ nodes: [...g.nodes, node], edges: g.edges }))
      if (drop.sourceNodeId) {
        const stale = graphRef.current.edges.filter(
          (e) => e.target_node_id === node.id,
        )
        for (const e of stale) {
          await api(`/api/automations/${initial.id}/edges/${e.id}`, "DELETE")
        }
        const edgeJson = await api<{ edge: AutomationEdgeRow }>(
          `/api/automations/${initial.id}/edges`,
          "POST",
          {
            source_node_id: drop.sourceNodeId,
            target_node_id: node.id,
            source_handle: drop.sourceHandle,
          },
        )
        setGraph((g) => ({ nodes: g.nodes, edges: [...g.edges, edgeJson.edge] }))
      }
      setSelectedId(node.id)
    } catch (err) {
      toastIssue(err)
      await refreshGraph()
    }
  }

  function handleNodeDelete(id: string) {
    const node = graphRef.current.nodes.find((n) => n.id === id)
    if (!node) return
    if (node.type === "starting_step") {
      // The starting step is the graph's anchor — RF marks it
      // undeletable; this also guards the panel's Delete button.
      toast.error(t("canvas.startingStepLocked"))
      return
    }
    if (selectedId === id) setSelectedId(null)
    if (!isEditing) {
      removeNodesLocal(new Set([id]))
      return
    }
    void (async () => {
      try {
        await api(`/api/automations/${initial.id}/nodes/${id}`, "DELETE")
        removeNodesLocal(new Set([id]))
      } catch (err) {
        toastIssue(err)
        await refreshGraph()
      }
    })()
  }

  function handleEdgeDelete(id: string) {
    if (!isEditing) {
      setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }))
      return
    }
    void (async () => {
      try {
        await api(`/api/automations/${initial.id}/edges/${id}`, "DELETE")
        setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }))
      } catch (err) {
        toastIssue(err)
        await refreshGraph()
      }
    })()
  }

  // ------------------------------------------------------------
  // Save — top-level fields (+ the whole graph on the create path)
  // ------------------------------------------------------------

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: top.name || t("untitled"),
        description: top.description || null,
        trigger_type: top.trigger_type,
        trigger_config: top.trigger_config,
        is_active: top.is_active,
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, graph }),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? t("toasts.saveFailed"))
        }
        return
      }
      toast.success(isEditing ? t("toasts.saved") : t("toasts.created"))
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  function patchTop<K extends keyof TopFields>(key: K, value: TopFields[K]) {
    setTop((s) => ({ ...s, [key]: value }))
  }

  // ------------------------------------------------------------
  // Publish — run the whole-graph validation gate on the server and
  // render its structured {errors, warnings}. Blocking errors keep the
  // flow unpublished; warnings only need a confirmation click.
  // ------------------------------------------------------------

  async function publishFlow(confirmWarnings = false) {
    setPublishing(true)
    try {
      // Existing automation → the dedicated publish gate.
      // New automation → the create endpoint's atomic publish path, which
      // validates the in-memory graph and only persists once it is
      // publishable (so a failed Publish leaves no orphan draft and
      // repeated clicks never create duplicates). Both answer with the
      // same {ok, needsConfirmation, errors, warnings} shape.
      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}/publish`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmWarnings }),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: top.name || t("untitled"),
              description: top.description || null,
              trigger_type: top.trigger_type,
              trigger_config: top.trigger_config,
              is_active: false,
              graph,
              publish: true,
              confirmWarnings,
            }),
          })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        needsConfirmation?: boolean
        errors?: PublishIssue[]
        warnings?: PublishIssue[]
      }
      if (body.ok) {
        setResults(null)
        toast.success(t("toasts.published"))
        router.push("/automations")
        return
      }
      const errors = body.errors ?? []
      const warnings = body.warnings ?? []
      // Both blocking errors and advisory-only warnings render in the
      // same panel — the panel's footer decides which action is offered.
      setResults({ errors, warnings })
      if (errors.length > 0) {
        toast.error(body.error ?? t("toasts.publishFailed"))
      }
    } finally {
      setPublishing(false)
    }
  }

  /** Pan/zoom the canvas onto an issue's node and open its config. */
  function revealIssueNode(path: string) {
    const id = nodeIdFromPath(path)
    if (!id) return
    setSelectedId(id)
    setFocus((f) => ({ id, nonce: (f?.nonce ?? 0) + 1 }))
  }

  /** Snapshot the live graph and open the dry-run test panel. Works on
   *  unsaved drafts too — the walk runs entirely client-side. */
  function openTestPanel() {
    setTestGraph({ nodes: graph.nodes, edges: graph.edges })
    setTesting(true)
  }

  return (
    /* z-40 lifts this full-screen overlay above the dashboard chrome (sticky
       nav is z-20, sidebar is z-30). Without an explicit z-index the overlay
       sits at z-auto, so the nav paints over the top bar and hides the
       Test / Publish / Save buttons while the canvas below still shows. */
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={top.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("untitled")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{t("active")}</span>
          <Switch
            checked={top.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label={t("activeAria")}
          />
        </div>
        <Button
          variant="outline"
          onClick={openTestPanel}
          className="gap-1.5 border-border bg-transparent text-foreground hover:bg-muted"
        >
          <Zap className="h-4 w-4" />
          <span className="hidden sm:inline">{t("publish.test")}</span>
        </Button>
        <Button
          onClick={() => void publishFlow(false)}
          disabled={publishing}
          className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-600/90 disabled:opacity-50"
        >
          {publishing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">{t("publish.button")}</span>
        </Button>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t("save") : t("saveDraft")}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative min-h-0 flex-1">
        <ResourcesProvider>
          <AutomationCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selectedId}
            triggerType={top.trigger_type}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            onDropOnCanvas={setDropTarget}
            onNodeDelete={handleNodeDelete}
            onEdgeDelete={handleEdgeDelete}
            onNodeSelected={setSelectedId}
            focusNode={focus}
          />
          {testing && testGraph && (
            <FlowTestPanel
              open
              onClose={() => setTesting(false)}
              graph={testGraph}
              triggerType={top.trigger_type}
              triggerConfig={top.trigger_config}
            />
          )}
        </ResourcesProvider>

        {results && (
          <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center p-3 sm:p-4">
            <div className="bg-card w-full max-w-2xl overflow-hidden rounded-xl border border-border shadow-[0_16px_48px_-16px_rgba(0,0,0,0.5)]">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <p className="text-sm font-semibold text-foreground">
                  {results.errors.length > 0
                    ? t("publish.errorsTitle", { count: results.errors.length })
                    : t("publish.warningsTitle", { count: results.warnings.length })}
                </p>
                <button
                  type="button"
                  onClick={() => setResults(null)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t("publish.close")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto px-2 py-2">
                {results.errors.map((issue, i) => (
                  <IssueRow
                    key={`e${i}`}
                    issue={issue}
                    tone="error"
                    onReveal={revealIssueNode}
                    nodeLabelOf={(id) =>
                      graph.nodes.find((n) => n.id === id)?.type
                    }
                  />
                ))}
                {results.warnings.map((issue, i) => (
                  <IssueRow
                    key={`w${i}`}
                    issue={issue}
                    tone="warning"
                    onReveal={revealIssueNode}
                    nodeLabelOf={(id) =>
                      graph.nodes.find((n) => n.id === id)?.type
                    }
                  />
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
                {results.errors.length === 0 && results.warnings.length > 0 ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setResults(null)}
                      className="border-border text-foreground"
                    >
                      {t("publish.back")}
                    </Button>
                    <Button
                      onClick={() => void publishFlow(true)}
                      disabled={publishing}
                      className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-600/90"
                    >
                      {publishing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      {t("publish.publishAnyway")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setResults(null)}
                    className="border-border text-foreground"
                  >
                    {t("publish.back")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <SelectActionDialog
        open={dropTarget !== null}
        onClose={() => setDropTarget(null)}
        onPick={(type) => void createNodeAtDrop(type)}
      />

      <NodeConfigPanel
        node={selectedNode}
        triggerType={top.trigger_type}
        triggerConfig={top.trigger_config}
        onTriggerTypeChange={(v) => patchTop("trigger_type", v)}
        onTriggerConfigChange={(c) => patchTop("trigger_config", c)}
        onConfigChange={handleConfigChange}
        onDelete={handleNodeDelete}
        onClose={() => setSelectedId(null)}
      />
    </div>
  )
}

// ------------------------------------------------------------
// Publish-result row. Blocking errors and advisory warnings share one
// layout; a row whose path points at a concrete node is clickable and
// pans the canvas onto it (via `onReveal`).
// ------------------------------------------------------------

function IssueRow({
  issue,
  tone,
  onReveal,
  nodeLabelOf,
}: {
  issue: PublishIssue
  tone: "error" | "warning"
  onReveal: (path: string) => void
  nodeLabelOf: (id: string) => AutomationNodeType | undefined
}) {
  const t = useTranslations("Automations.builder")
  const nodeId = nodeIdFromPath(issue.path)
  const nodeType = nodeId ? nodeLabelOf(nodeId) : undefined
  const label = nodeType ? t(`nodeTypes.${nodeType}.label`) : null
  const isError = tone === "error"
  return (
    <button
      type="button"
      disabled={!nodeId}
      onClick={() => nodeId && onReveal(issue.path)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        nodeId ? "hover:bg-muted" : "cursor-default",
      )}
    >
      {isError ? (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      ) : (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      )}
      <span className="min-w-0 flex-1">
        {label && (
          <span className="mr-1.5 font-semibold text-foreground">{label}:</span>
        )}
        <span className="text-muted-foreground">{issue.message}</span>
      </span>
      {nodeId && (
        <span className="text-primary shrink-0 text-xs font-medium">
          {t("publish.reveal")}
        </span>
      )}
    </button>
  )
}

// ------------------------------------------------------------
// Legacy step-tree helpers. The vertical builder that consumed them
// is gone, but template-seed pages and older callers still import
// these, so the shapes stay exported.
// ------------------------------------------------------------

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: uid(),
    step_type: n.step_type,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
