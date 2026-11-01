"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as RfEdge,
  type EdgeProps,
  type Node as RfNode,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { AutomationTriggerType } from "@/types"
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive"
import {
  AUTOMATION_NODE_META,
  LEGACY_NODE_TYPES,
  PALETTE_NODE_TYPES,
  type AutomationEdgeRow,
  type AutomationNodeRow,
  type AutomationNodeType,
} from "@/lib/automations/graph-types"
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive"

// ------------------------------------------------------------
// The n8n-style automation canvas. Owns no graph state — the
// builder shell does — and reports intent through callbacks
// (connect, drop-on-empty-canvas, drag, delete, selection).
// Rows arrive as automation_nodes/edges-shaped objects and are
// projected onto React Flow's node/edge model here.
// ------------------------------------------------------------

export interface CanvasDropTarget {
  /** The handle the drag started from (always set — connections
   *  only originate at a source handle). */
  sourceNodeId: string
  sourceHandle: "yes" | "no" | null
  /** Flow coordinates of the release point — the new node spawns here. */
  x: number
  y: number
}

interface AutomationCanvasProps {
  nodes: AutomationNodeRow[]
  edges: AutomationEdgeRow[]
  /** Currently selected node id (drives the card's highlight ring). */
  selectedId: string | null
  /** Drives the starting_step card's subtitle. */
  triggerType: AutomationTriggerType
  onNodeDragStop: (id: string, x: number, y: number) => void
  onConnect: (params: {
    source: string
    target: string
    handle: "yes" | "no" | null
  }) => void
  onDropOnCanvas: (drop: CanvasDropTarget) => void
  onNodeDelete: (id: string) => void
  onEdgeDelete: (id: string) => void
  onNodeSelected: (id: string) => void
  /** Bump `nonce` to pan/zoom the viewport onto `id` (used by the
   *  publish panel's "click an error → reveal that node" affordance). */
  focusNode?: { id: string; nonce: number } | null
}

export function AutomationCanvas(props: AutomationCanvasProps) {
  return (
    <ReactFlowProvider>
      <AutomationCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

// React-Flow node `data` payload — the bits our custom renderer needs.
interface NodeData extends Record<string, unknown> {
  node: AutomationNodeRow
  triggerLabel?: string
  onDelete?: (id: string) => void
}

// Connection styling — every edge is a dotted dark-blue line (the branch
// Yes/No label stays as the only colour cue, per the request to keep
// everything else untouched).
const EDGE_COLOR = "#1d4ed8" // dark blue
const EDGE_DASH = "4 4"

function AutomationCanvasInner({
  nodes,
  edges,
  selectedId,
  triggerType,
  onNodeDragStop,
  onConnect,
  onDropOnCanvas,
  onNodeDelete,
  onEdgeDelete,
  onNodeSelected,
  focusNode,
}: AutomationCanvasProps) {
  const t = useTranslations("Automations.builder")
  const reactFlow = useReactFlow()

  const triggerLabel = t(`triggers.${triggerType}.label`)

  // RF keeps per-node ephemeral state (drag position), so the
  // controlled list is derived from the authoritative rows; selection
  // is sourced from the `selectedId` prop rather than read back out of
  // prior state (keeping the derivation a pure memo).
  const derivedRfNodes = useMemo<RfNode<NodeData>[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: "automation",
        position: { x: n.position_x, y: n.position_y },
        // The starting step is the graph's anchor — never deletable.
        deletable: n.type !== "starting_step",
        selected: n.id === selectedId,
        data: { node: n, triggerLabel, onDelete: onNodeDelete },
      })),
    [nodes, selectedId, triggerLabel, onNodeDelete],
  )

  const [rfNodes, setRfNodes] = useState<RfNode<NodeData>[]>(derivedRfNodes)
  useEffect(() => {
    setRfNodes(derivedRfNodes)
  }, [derivedRfNodes])

  // Reveal a specific node in the viewport when the builder asks (an
  // error row in the publish panel was clicked).
  useEffect(() => {
    if (!focusNode?.id) return
    reactFlow.fitView({ nodes: [{ id: focusNode.id }], duration: 400, maxZoom: 1.1 })
    // refitView intentionally keyed on nonce so repeated clicks on the
    // same node still re-center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNode?.id, focusNode?.nonce])

  const rfEdges = useMemo<RfEdge[]>(
    () =>
      edges.map((e) => ({
        id: e.id,
        type: "deletable",
        source: e.source_node_id,
        target: e.target_node_id,
        sourceHandle: e.source_handle ?? null,
        label:
          e.source_handle === "yes"
            ? t("branches.yes")
            : e.source_handle === "no"
              ? t("branches.no")
              : undefined,
        labelStyle: { fontSize: 10, fontWeight: 600 },
        data: { onEdgeDelete },
        style: {
          strokeWidth: 1.5,
          stroke: EDGE_COLOR,
          strokeDasharray: EDGE_DASH,
        },
      })),
    [edges, t, onEdgeDelete],
  )

  const handleNodesChange = useCallback((changes: NodeChange<RfNode<NodeData>>[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: RfNode<NodeData>) => {
      onNodeDragStop(node.id, node.position.x, node.position.y)
    },
    [onNodeDragStop],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      const handle =
        connection.sourceHandle === "yes" || connection.sourceHandle === "no"
          ? connection.sourceHandle
          : null
      onConnect({ source: connection.source, target: connection.target, handle })
    },
    [onConnect],
  )

  // Drag from a handle and release over EMPTY canvas → "Select Action"
  // modal at the drop point. A release over another node is handled by
  // onConnect instead (toNode set).
  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      const fromNode = connectionState.fromNode
      if (!fromNode || connectionState.toNode) return
      if (!("clientX" in event)) return
      const point = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      const handle =
        connectionState.fromHandle?.id === "yes" ||
        connectionState.fromHandle?.id === "no"
          ? (connectionState.fromHandle.id as "yes" | "no")
          : null
      onDropOnCanvas({ sourceNodeId: fromNode.id, sourceHandle: handle, x: point.x, y: point.y })
    },
    [reactFlow, onDropOnCanvas],
  )

  const handleNodesDelete = useCallback(
    (deleted: RfNode<NodeData>[]) => {
      for (const n of deleted) onNodeDelete(n.id)
    },
    [onNodeDelete],
  )

  const handleEdgesDelete = useCallback(
    (deleted: RfEdge[]) => {
      for (const e of deleted) onEdgeDelete(e.id)
    },
    [onEdgeDelete],
  )

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: RfNode<NodeData>) => {
      onNodeSelected(node.id)
    },
    [onNodeSelected],
  )

  const nodeTypes = useMemo(() => ({ automation: AutomationNodeCard }), [])
  const edgeTypes = useMemo(() => ({ deletable: DeletableEdge }), [])

  return (
    <div className="h-full w-full overflow-hidden">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={handleNodeClick}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        // Default is "Backspace" only — accept both so Mac users
        // hitting Delete (Fn+Backspace) get the same behavior.
        deleteKeyCode={["Backspace", "Delete"]}
        nodesConnectable
        edgesFocusable
        elementsSelectable
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--border)" />
        <Controls
          className="!border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button:hover]:!bg-muted [&_button_svg]:!fill-foreground !overflow-hidden !rounded-xl !border !shadow-[0_6px_20px_-8px_rgba(0,0,0,0.5)]"
          showInteractive={false}
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const hue = AUTOMATION_NODE_META[(n.data as NodeData).node.type]?.color
            return (hue && CHIP_SOLID[hue]) || "#64748b"
          }}
          nodeStrokeWidth={0}
          nodeBorderRadius={3}
          maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
          className="!border-border !bg-card !rounded-xl !border !shadow-[0_6px_20px_-8px_rgba(0,0,0,0.5)]"
        />
        <Panel position="top-center" className="!top-4">
          <p className="bg-card/90 text-muted-foreground max-w-[90vw] rounded-full border border-border px-4 py-1.5 text-center text-[11px] shadow-sm">
            {t("canvas.hint")}
          </p>
        </Panel>
      </ReactFlow>
    </div>
  )
}

// ============================================================
// Custom node card — styled after the legacy TriggerCard
// (rounded, left accent border, icon chip, eyebrow label).
// ============================================================

function AutomationNodeCard({ data, selected }: NodeProps) {
  const t = useTranslations("Automations.builder")
  const { node, triggerLabel, onDelete } = data as NodeData
  const type = node.type
  const meta = AUTOMATION_NODE_META[type] ?? AUTOMATION_NODE_META.send_message
  const Icon = meta.icon
  const hue = meta.color
  const isStart = type === "starting_step"
  const isCondition = type === "condition"

  return (
    <div
      className={cn(
        "bg-card group relative w-[240px] rounded-lg border border-l-4 px-3.5 py-3 text-left shadow-[0_2px_6px_rgba(0,0,0,0.18)] transition-[box-shadow,border-color]",
        ACCENT_CLASS[hue]?.border ?? "border-l-border",
        selected
          ? "ring-2 ring-primary/60"
          : "border-border hover:border-primary/40",
      )}
    >
      {/* Cross mark on top — removes the node (never shown on the anchor). */}
      {!isStart && onDelete && (
        <button
          type="button"
          aria-label="Remove node"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(node.id)
          }}
          className="nodrag nopan absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-rose-500/60 bg-card text-rose-500 shadow-sm transition-colors hover:bg-rose-500 hover:text-white"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {!isStart && (
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-card !h-2.5 !w-2.5 !border-2 !border-border"
        />
      )}

      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            ACCENT_CLASS[hue]?.chip ?? "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate text-[10.5px] font-semibold uppercase tracking-wider",
              ACCENT_CLASS[hue]?.text ?? "text-muted-foreground",
            )}
          >
            {isStart ? t("trigger") : nodeCategoryLabel(t, type)}
          </div>
          <div className="truncate text-sm font-medium text-foreground">
            {nodeTitle(t, type)}
          </div>
        </div>
      </div>

      {/* One-line config summary so the canvas reads without opening panels. */}
      <div className="text-muted-foreground mt-1.5 line-clamp-2 text-[11px] leading-snug">
        {isStart ? (triggerLabel ?? "") : summarizeGraphNode(t, node)}
      </div>

      {isCondition ? (
        // Two labeled source ports — the Yes/No branches.
        <div className="border-border mt-2 flex flex-col gap-1 border-t pt-2">
          {(["yes", "no"] as const).map((h) => (
            <div
              key={h}
              className={cn(
                "relative flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] font-semibold uppercase",
                h === "yes" ? "text-emerald-400" : "text-rose-400",
              )}
            >
              <span>{t(`branches.${h}`)}</span>
              <Handle
                type="source"
                id={h}
                position={Position.Right}
                className={cn(
                  "!bg-card !relative !top-auto !right-auto !h-2.5 !w-2.5 !translate-x-[14px] !transform-none !border-2",
                  h === "yes" ? "!border-emerald-500" : "!border-rose-500",
                )}
              />
            </div>
          ))}
        </div>
      ) : (
        // Every other node: a single unlabeled source dot. No `id`, so
        // the resulting edge carries source_handle = null — the exact
        // contract the edges API enforces for non-condition nodes.
        <Handle
          type="source"
          position={Position.Right}
          className={cn(
            "!bg-card !h-2.5 !w-2.5 !border-2",
            ACCENT_CLASS[hue]?.ring ?? "!border-border",
          )}
        />
      )}
    </div>
  )
}

// ============================================================
// Custom edge — dotted dark-blue line with a cross button at its
// midpoint that cancels (deletes) the connection.
// ============================================================

function DeletableEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  })
  const onEdgeDelete = (
    props.data as { onEdgeDelete?: (id: string) => void } | undefined
  )?.onEdgeDelete
  const label = props.label as string | undefined

  return (
    <>
      <BaseEdge id={props.id} path={path} style={props.style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
          className="nodrag nopan flex items-center gap-1"
        >
          {label ? (
            <span style={props.labelStyle as React.CSSProperties}>{label}</span>
          ) : null}
          {onEdgeDelete ? (
            <button
              type="button"
              aria-label="Remove connection"
              onClick={() => onEdgeDelete(props.id)}
              className="flex h-4 w-4 items-center justify-center rounded-full border border-rose-500/60 bg-card text-rose-500 shadow-sm transition-colors hover:bg-rose-500 hover:text-white"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

// ------------------------------------------------------------
// Labels + summaries
// ------------------------------------------------------------

const PALETTE_SET = new Set<string>(PALETTE_NODE_TYPES)
const LEGACY_ONLY = new Set<string>(
  LEGACY_NODE_TYPES.filter((tp) => !PALETTE_SET.has(tp)),
)

/** True for passthrough step types that exist only on migrated
 *  automations — they have no nodeTypes.* i18n entries (titles come
 *  from builder.steps.*). */
export function isLegacyOnlyType(type: AutomationNodeType): boolean {
  return LEGACY_ONLY.has(type)
}

/** Palette + starting node names come from nodeTypes.*; legacy-only
 *  passthrough types reuse the existing builder.steps.* keys (they're
 *  already translated in every locale). Exported so the config panel
 *  header shows the same title as the card. */
export function nodeTitle(
  t: ReturnType<typeof useTranslations>,
  type: AutomationNodeType,
): string {
  if (type === "starting_step") return t("nodeTypes.starting_step.label")
  if (LEGACY_ONLY.has(type)) return t(`steps.${type}`)
  return t(`nodeTypes.${type}.label`)
}

function nodeCategoryLabel(
  t: ReturnType<typeof useTranslations>,
  type: AutomationNodeType,
): string {
  if (type === "condition") return t("kindCondition")
  if (type === "time_delay" || type === "wait") return t("kindWait")
  return t("kindAction")
}

/** Compact config digest shown under the node title. */
function summarizeGraphNode(
  t: ReturnType<typeof useTranslations>,
  node: AutomationNodeRow,
): string {
  const c = node.config
  switch (node.type) {
    case "text_button":
    case "list":
    case "send_buttons":
    case "send_list":
      return (
        interactivePayloadPreviewText(c as unknown as InteractiveMessagePayload) ||
        t("canvas.noBodyYet")
      )
    case "send_message":
      return String(c.text ?? "") || t("canvas.noTextYet")
    case "media":
      return `${String(c.media_kind ?? "image")} · ${String(c.url ?? "") || t("canvas.noFileYet")}`
    case "audio":
      return String(c.url ?? "") || t("canvas.noFileYet")
    case "template":
    case "send_template":
      return String(c.template_name ?? "") || t("canvas.pickTemplate")
    case "ask_question":
      return String(c.text ?? "") || t("canvas.noTextYet")
    case "whatsapp_form":
      return String(c.flow_id ?? "") || t("canvas.pickFlow")
    case "payment": {
      const amount = String(c.amount ?? "0")
      return `${amount} ${String(c.currency ?? "")}`.trim()
    }
    case "save_attribute":
    case "update_contact_field":
      return String(c.field ?? "") || t("canvas.pickField")
    case "add_tag":
    case "remove_tag":
      return String(c.tag_id ?? "").slice(0, 8) || t("canvas.pickTag")
    case "google_sheet":
      return String(c.spreadsheet ?? "") || t("canvas.notConfigured")
    case "meta_capi":
      return String(c.event_type ?? "") || t("canvas.notConfigured")
    case "time_delay":
    case "wait":
      return `${String(c.amount ?? "?")} ${String(c.unit ?? "")}`
    case "webhook":
    case "send_webhook":
      return String(c.url ?? "") || t("canvas.noUrl")
    case "condition":
      return `${t("canvas.whenPrefix")} ${String(c.subject ?? "?")}`
    case "assign_conversation":
      return String(c.mode ?? "round_robin")
    case "create_deal":
      return String(c.title ?? "") || t("canvas.notConfigured")
    case "close_conversation":
      return t("config.closeConversationHint")
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Static Tailwind classes per hue — dynamically composed names are
// invisible to the JIT scanner, so every AUTOMATION_NODE_META color
// gets literal entries here.
// ------------------------------------------------------------

export interface HueClasses {
  chip: string
  text: string
  border: string
  ring: string
  solid: string
}

export const ACCENT_CLASS: Record<string, HueClasses> = {
  blue: { chip: "bg-blue-500/10 text-blue-400", text: "text-blue-400", border: "border-l-blue-500", ring: "!border-blue-500/60", solid: "#3b82f6" },
  emerald: { chip: "bg-emerald-500/10 text-emerald-400", text: "text-emerald-400", border: "border-l-emerald-500", ring: "!border-emerald-500/60", solid: "#10b981" },
  violet: { chip: "bg-violet-500/10 text-violet-400", text: "text-violet-400", border: "border-l-violet-500", ring: "!border-violet-500/60", solid: "#8b5cf6" },
  fuchsia: { chip: "bg-fuchsia-500/10 text-fuchsia-400", text: "text-fuchsia-400", border: "border-l-fuchsia-500", ring: "!border-fuchsia-500/60", solid: "#d946ef" },
  teal: { chip: "bg-teal-500/10 text-teal-400", text: "text-teal-400", border: "border-l-teal-500", ring: "!border-teal-500/60", solid: "#14b8a6" },
  indigo: { chip: "bg-indigo-500/10 text-indigo-400", text: "text-indigo-400", border: "border-l-indigo-500", ring: "!border-indigo-500/60", solid: "#6366f1" },
  amber: { chip: "bg-amber-500/10 text-amber-400", text: "text-amber-400", border: "border-l-amber-500", ring: "!border-amber-500/60", solid: "#f59e0b" },
  cyan: { chip: "bg-cyan-500/10 text-cyan-400", text: "text-cyan-400", border: "border-l-cyan-500", ring: "!border-cyan-500/60", solid: "#06b6d4" },
  orange: { chip: "bg-orange-500/10 text-orange-400", text: "text-orange-400", border: "border-l-orange-500", ring: "!border-orange-500/60", solid: "#f97316" },
  sky: { chip: "bg-sky-500/10 text-sky-400", text: "text-sky-400", border: "border-l-sky-500", ring: "!border-sky-500/60", solid: "#0ea5e9" },
  green: { chip: "bg-green-500/10 text-green-400", text: "text-green-400", border: "border-l-green-500", ring: "!border-green-500/60", solid: "#22c55e" },
  rose: { chip: "bg-rose-500/10 text-rose-400", text: "text-rose-400", border: "border-l-rose-500", ring: "!border-rose-500/60", solid: "#f43f5e" },
  slate: { chip: "bg-slate-500/10 text-slate-400", text: "text-slate-400", border: "border-l-slate-400", ring: "!border-slate-500/60", solid: "#64748b" },
}

const CHIP_SOLID: Record<string, string> = Object.fromEntries(
  Object.entries(ACCENT_CLASS).map(([hue, c]) => [hue, c.solid]),
)
