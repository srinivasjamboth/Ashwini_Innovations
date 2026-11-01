import { describe, it, expect } from "vitest"

import {
  compileGraphToSteps,
  decompileStepsToGraph,
  validateGraphConfig,
  wouldCreateCycle,
  paymentText,
} from "./graph"
import type {
  AutomationEdgeRow,
  AutomationNodeRow,
  AutomationNodeType,
} from "./graph-types"

// ------------------------------------------------------------
// Fixtures — graph.ts is pure, so we build node/edge rows by hand.
// `automation_id` / `account_id` are placeholders the library never
// reads (tenancy is enforced at the route layer), so a constant is
// enough. `created_at` drives edge ordering, so tests set it when
// ordering matters.
// ------------------------------------------------------------

const mkNode = (
  id: string,
  type: AutomationNodeType,
  config: Record<string, unknown> = {},
): AutomationNodeRow => ({
  id,
  automation_id: "auto",
  account_id: "acct",
  type,
  config,
  position_x: 0,
  position_y: 0,
})

const mkEdge = (
  id: string,
  source: string,
  target: string,
  handle: "yes" | "no" | null = null,
  created_at?: string,
): AutomationEdgeRow => ({
  id,
  automation_id: "auto",
  account_id: "acct",
  source_node_id: source,
  target_node_id: target,
  source_handle: handle,
  ...(created_at ? { created_at } : {}),
})

describe("compileGraphToSteps", () => {
  it("compiles a linear chain off the starting step into sequential siblings", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("a", "add_tag", { tag_id: "t1" }),
      mkNode("b", "time_delay", { amount: 2, unit: "hours" }),
    ]
    const edges = [mkEdge("e1", "s", "a"), mkEdge("e2", "a", "b")]

    const steps = compileGraphToSteps(nodes, edges)
    expect(steps).toEqual([
      { step_type: "add_tag", step_config: { tag_id: "t1" } },
      { step_type: "wait", step_config: { amount: 2, unit: "hours" } },
    ])
  })

  it("compiles a condition's yes/no handles into named branches", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("c", "condition", { subject: "tag_presence", operand: "vip" }),
      mkNode("y", "add_tag", { tag_id: "yes-tag" }),
      mkNode("n", "time_delay", { amount: 1, unit: "minutes" }),
    ]
    const edges = [
      mkEdge("e0", "s", "c"),
      mkEdge("ey", "c", "y", "yes"),
      mkEdge("en", "c", "n", "no"),
    ]

    const steps = compileGraphToSteps(nodes, edges)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      step_type: "condition",
      step_config: { subject: "tag_presence", operand: "vip" },
      branches: {
        yes: [{ step_type: "add_tag", step_config: { tag_id: "yes-tag" } }],
        no: [{ step_type: "wait", step_config: { amount: 1, unit: "minutes" } }],
      },
    })
  })

  it("orders multiple plain edges from one node by created_at", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("a", "add_tag", { tag_id: "A" }),
      mkNode("b", "add_tag", { tag_id: "B" }),
    ]
    // B was wired first even though it appears second in the array.
    const edges = [
      mkEdge("e1", "s", "a", null, "2024-01-02T00:00:00Z"),
      mkEdge("e2", "s", "b", null, "2024-01-01T00:00:00Z"),
    ]

    const steps = compileGraphToSteps(nodes, edges)
    expect(steps.map((s) => s.step_config.tag_id)).toEqual(["B", "A"])
  })

  it("does not recurse forever on a cycle (defensive skip)", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("a", "add_tag", { tag_id: "A" }),
      mkNode("b", "add_tag", { tag_id: "B" }),
    ]
    const edges = [mkEdge("e1", "s", "a"), mkEdge("e2", "a", "b"), mkEdge("e3", "b", "a")]

    const steps = compileGraphToSteps(nodes, edges)
    // a and b each compile once; the b→a back-edge is dropped.
    expect(steps).toHaveLength(2)
    expect(steps.map((s) => s.step_config.tag_id)).toEqual(["A", "B"])
  })

  it("maps the payment palette node to a summary text message", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("p", "payment", { amount: 12.5, currency: "usd", description: "Order #9" }),
    ]
    const edges = [mkEdge("e1", "s", "p")]

    const steps = compileGraphToSteps(nodes, edges)
    expect(steps[0].step_type).toBe("send_message")
    expect((steps[0].step_config as { text: string }).text).toBe(paymentText({ amount: 12.5, currency: "usd", description: "Order #9" }))
  })
})

describe("decompileStepsToGraph", () => {
  it("produces exactly one starting step and preserves every node", () => {
    const steps = [
      { step_type: "add_tag", step_config: { tag_id: "t1" } },
      {
        step_type: "condition",
        step_config: { subject: "contact_field", operand: "plan" },
        branches: {
          yes: [{ step_type: "wait", step_config: { amount: 5, unit: "minutes" } }],
          no: [],
        },
      },
    ]
    const graph = decompileStepsToGraph(steps)
    expect(graph.nodes.filter((n) => n.type === "starting_step")).toHaveLength(1)
    const types = graph.nodes.map((n) => n.type)
    expect(types).toContain("add_tag")
    expect(types).toContain("condition")
    expect(types).toContain("time_delay")
  })

  it("compile → decompile → compile round-trips losslessly for the E2E scenario", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("tb", "text_button", { text: "Pick one", buttons: [{ id: "b1", title: "Yes" }] }),
      mkNode("c", "condition", { subject: "tag_presence", operand: "vip" }),
      mkNode("tag", "add_tag", { tag_id: "hot" }),
      mkNode("delay", "time_delay", { amount: 30, unit: "minutes" }),
      mkNode("tpl", "template", { template_name: "welcome" }),
    ]
    const edges = [
      mkEdge("e1", "s", "tb"),
      mkEdge("e2", "tb", "c"),
      mkEdge("e3", "c", "tag", "yes"),
      mkEdge("e4", "c", "delay", "no"),
      mkEdge("e5", "delay", "tpl"),
    ]

    const first = compileGraphToSteps(nodes, edges)
    const regenerated = decompileStepsToGraph(first)
    const second = compileGraphToSteps(regenerated.nodes, regenerated.edges)

    // Ids/positions differ after decompile, but the compiled tree —
    // the actual execution artifact — must be byte-identical.
    expect(second).toEqual(first)
    // start → Text+Button → Condition is two sequential root siblings.
    expect(first.map((s) => s.step_type)).toEqual(["send_buttons", "condition"])
  })
})

describe("validateGraphConfig", () => {
  const validNodes = (): AutomationNodeRow[] => [
    mkNode("s", "starting_step"),
    mkNode("w", "webhook", { url: "https://example.com/hook", method: "POST" }),
    mkNode("tag", "add_tag", { tag_id: "t1" }),
  ]
  const validEdges = (): AutomationEdgeRow[] => [
    mkEdge("e1", "s", "w"),
    mkEdge("e2", "w", "tag"),
  ]

  it("passes a well-formed graph with no issues", () => {
    expect(validateGraphConfig(validNodes(), validEdges())).toEqual([])
  })

  it("rejects a graph with no starting step", () => {
    const nodes = [mkNode("a", "add_tag", { tag_id: "t1" })]
    const issues = validateGraphConfig(nodes, [])
    expect(issues.some((i) => i.path === "graph.starting_step")).toBe(true)
  })

  it("reports a loop", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("a", "add_tag", { tag_id: "A" }),
      mkNode("b", "add_tag", { tag_id: "B" }),
    ]
    const edges = [mkEdge("e1", "s", "a"), mkEdge("e2", "a", "b"), mkEdge("e3", "b", "a")]
    const issues = validateGraphConfig(nodes, edges)
    expect(issues.some((i) => i.path === "graph.cycle")).toBe(true)
  })

  it("flags an unreachable node", () => {
    const nodes = [...validNodes(), mkNode("orphan", "add_tag", { tag_id: "X" })]
    const issues = validateGraphConfig(nodes, validEdges())
    expect(issues.some((i) => i.path === "nodes.orphan")).toBe(true)
  })

  it("requires both Yes and No branches on a condition", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("c", "condition", { subject: "tag_presence", operand: "vip" }),
      mkNode("y", "add_tag", { tag_id: "yes" }),
    ]
    const edges = [mkEdge("e1", "s", "c"), mkEdge("e2", "c", "y", "yes")]
    const issues = validateGraphConfig(nodes, edges)
    // No branch missing.
    expect(issues.some((i) => i.path.endsWith(".no"))).toBe(true)
    expect(issues.some((i) => i.path.endsWith(".yes"))).toBe(false)
  })

  it("enforces per-node required config fields", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("w", "webhook", { url: "not-a-url", method: "POST" }),
      mkNode("p", "payment", { amount: 0, currency: "" }),
      mkNode("q", "ask_question", { text: "Name?", variable: "" }),
    ]
    const edges = [mkEdge("e1", "s", "w"), mkEdge("e2", "w", "p"), mkEdge("e3", "p", "q")]
    const issues = validateGraphConfig(nodes, edges)
    expect(issues.some((i) => i.path === "nodes.w.url")).toBe(true)
    expect(issues.some((i) => i.path === "nodes.p.amount")).toBe(true)
    expect(issues.some((i) => i.path === "nodes.p.currency")).toBe(true)
    expect(issues.some((i) => i.path === "nodes.q.variable")).toBe(true)
  })

  it("rejects a node with more than one incoming connection", () => {
    const nodes = [
      mkNode("s", "starting_step"),
      mkNode("a", "add_tag", { tag_id: "A" }),
      mkNode("b", "add_tag", { tag_id: "B" }),
      mkNode("join", "time_delay", { amount: 1, unit: "minutes" }),
    ]
    const edges = [
      mkEdge("e1", "s", "a"),
      mkEdge("e2", "s", "b"),
      mkEdge("e3", "a", "join"),
      mkEdge("e4", "b", "join"),
    ]
    const issues = validateGraphConfig(nodes, edges)
    expect(issues.some((i) => i.path === "nodes.join" && i.message.includes("incoming"))).toBe(true)
  })
})

describe("wouldCreateCycle", () => {
  it("detects a back-edge that closes a loop", () => {
    const edges = [{ source_node_id: "a", target_node_id: "b" }]
    expect(wouldCreateCycle(edges, "b", "a")).toBe(true)
  })

  it("allows a forward edge that opens no loop", () => {
    const edges = [{ source_node_id: "a", target_node_id: "b" }]
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false)
  })

  it("treats a self-loop as a cycle", () => {
    expect(wouldCreateCycle([], "a", "a")).toBe(true)
  })

  it("detects a longer indirect loop", () => {
    const edges = [
      { source_node_id: "a", target_node_id: "b" },
      { source_node_id: "b", target_node_id: "c" },
    ]
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true)
  })
})

describe("template node — structured variable config round-trips", () => {
  const cfg = {
    template_name: "order_update",
    language: "en_US",
    body: ["{{ vars.name }}", "{{ message.text }}"],
    headerText: "Hi {{ vars.name }}",
    buttonParams: { "0": "{{ vars.tracking }}" },
  }

  it("compiles the template node's full config into send_template step_config", () => {
    const nodes = [mkNode("s", "starting_step"), mkNode("a", "template", cfg)]
    const edges = [mkEdge("e1", "s", "a")]

    const steps = compileGraphToSteps(nodes, edges)
    expect(steps).toEqual([{ step_type: "send_template", step_config: cfg }])
  })

  it("decompiles a send_template step back into a template node with the same config", () => {
    const graph = decompileStepsToGraph([
      { step_type: "send_template", step_config: cfg } as never,
    ])
    const node = graph.nodes.find((n) => n.type === "template")
    expect(node?.config).toEqual(cfg)
  })
})
