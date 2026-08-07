import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/loader/model-graph.js";
import type { Flow, Junction, Loop } from "../src/schema/index.js";
import { renderFlowMermaid } from "../src/views/flow-mermaid.js";

/**
 * Multi-junction topology covering the same edge-direction cases the old
 * real-seed test did (Proposal 010 §5.1 — no target-repo seed ships with
 * this engine): a forward-adjacent chain, a BACKWARD projection edge
 * (L16→L2, not a forward traverses step), and a watchdog-to-loop edge from
 * a guarded_by loop (L9→L3) — the two shapes a naive "walk traverses pairs"
 * renderer would silently drop.
 */
function synthFlowGraph() {
  const loop = (id: string, title: string): Loop => ({
    kind: "loop",
    id,
    title,
    boundary: "b",
    owner: "o",
    status: "unverified",
    anchors: [],
    consumes_queues: [],
    scenarios: [],
  });
  const junction = (
    id: string,
    between: [string, string],
    risk_class: Junction["risk_class"],
  ): Junction => ({
    kind: "junction",
    id,
    between,
    risk_class,
    scenarios: [],
    evidence: [],
    status: "unverified",
  });
  return buildGraph([
    {
      file: "flow.yaml",
      node: {
        kind: "flow",
        id: "F1",
        title: "合成流",
        traverses: ["L1", "L2", "L3"],
        guarded_by: ["L9"],
        crosses: ["J-fwd", "J-back", "J-watch"],
        references: [],
        anchors: [],
        scenarios: [],
        status: "unverified",
      } as Flow,
    },
    { file: "l1.yaml", node: loop("L1", "一") },
    { file: "l2.yaml", node: loop("L2", "二") },
    { file: "l3.yaml", node: loop("L3", "三") },
    { file: "l9.yaml", node: loop("L9", "watchdog") },
    { file: "j1.yaml", node: junction("J-fwd", ["L1", "L2"], "handoff") },
    { file: "j2.yaml", node: junction("J-back", ["L2", "L1"], "projection") }, // backward: L2→L1
    { file: "j3.yaml", node: junction("J-watch", ["L9", "L3"], "watchdog") },
  ]);
}

describe("renderFlowMermaid — real seeded data (multi-junction topology)", () => {
  it("includes every traverses/guarded_by loop and the flow node, each with a real title", () => {
    const { graph } = synthFlowGraph();
    const mermaid = renderFlowMermaid(graph, "F1");

    expect(mermaid.startsWith("flowchart TB")).toBe(true);
    expect(mermaid).toContain('F1["F1: 合成流"]');
    for (const loopId of ["L1", "L2", "L3", "L9"]) {
      const loop = graph.byKind.loop.get(loopId);
      expect(loop).toBeDefined();
      expect(mermaid).toContain(`${loopId}["${loopId}: ${loop?.title}"]`);
    }
  });

  it("renders the traverses sequence as a plain forward chain", () => {
    const { graph } = synthFlowGraph();
    const mermaid = renderFlowMermaid(graph, "F1");

    expect(mermaid).toContain("F1 --> L1");
    expect(mermaid).toContain("L1 --> L2");
    expect(mermaid).toContain("L2 --> L3");
  });

  it("renders guarded_by as a dashed 'guards' edge into the flow node", () => {
    const { graph } = synthFlowGraph();
    const mermaid = renderFlowMermaid(graph, "F1");
    expect(mermaid).toContain("L9 -.->|guards| F1");
  });

  it("contains junction risk labels, including one that is NOT a forward-adjacent traverses step", () => {
    const { graph } = synthFlowGraph();
    const mermaid = renderFlowMermaid(graph, "F1");

    // forward-adjacent — labels carry the explicit from→to (A7 / Report 005 §5)
    expect(mermaid).toContain('L1 -.->|"J-fwd: handoff (L1→L2)"| L2');
    // NOT forward-adjacent: a backward projection edge (L2 -> L1) and a
    // watchdog-to-loop edge from a guarded_by loop (L9 -> L3) — these are
    // exactly the two edges a naive "walk traverses pairs" renderer would
    // silently drop, and the two whose direction the from→to label disambiguates.
    expect(mermaid).toContain('L2 -.->|"J-back: projection (L2→L1)"| L1');
    expect(mermaid).toContain('L9 -.->|"J-watch: watchdog (L9→L3)"| L3');

    for (const rc of ["handoff", "projection", "watchdog"]) {
      const occurrences = mermaid.split(rc).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(1);
    }
  });

  it("throws a clear error for an unknown flow id", () => {
    const { graph } = synthFlowGraph();
    expect(() => renderFlowMermaid(graph, "F-DOES-NOT-EXIST")).toThrow(/no such flow/);
  });
});

describe("renderFlowMermaid — synthetic minimal fixture", () => {
  function loop(overrides: Partial<Loop> & Pick<Loop, "id">): Loop {
    return {
      kind: "loop",
      title: "x",
      boundary: "b",
      owner: "o",
      status: "unverified",
      anchors: [],
      consumes_queues: [],
      scenarios: [],
      ...overrides,
    };
  }

  function flow(overrides: Partial<Flow> & Pick<Flow, "id">): Flow {
    return {
      kind: "flow",
      title: "x",
      traverses: [],
      guarded_by: [],
      crosses: [],
      references: [],
      anchors: [],
      scenarios: [],
      status: "unverified",
      ...overrides,
    };
  }

  function junction(overrides: Partial<Junction> & Pick<Junction, "id" | "between">): Junction {
    return {
      kind: "junction",
      risk_class: "handoff",
      scenarios: [],
      evidence: [],
      status: "unverified",
      ...overrides,
    };
  }

  it("declares a node for a loop referenced only via a junction's `between`, not in traverses/guarded_by", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"], crosses: ["J-x"] }) },
      { file: "b", node: loop({ id: "L1", title: "one" }) },
      { file: "c", node: loop({ id: "L99", title: "outside the chain" }) },
      { file: "d", node: junction({ id: "J-x", between: ["L1", "L99"], risk_class: "handoff" }) },
    ]);

    const mermaid = renderFlowMermaid(graph, "C1");
    expect(mermaid).toContain('L99["L99: outside the chain"]');
    expect(mermaid).toContain('L1 -.->|"J-x: handoff (L1→L99)"| L99');
  });

  /**
   * Proposal 016 T4 let `Junction.between` hold a FlowId. The endpoint title was
   * looked up in the LOOP table only, so a flow endpoint fell through to the
   * bare-id fallback and rendered as an untitled `C2["C2: C2"]` box — and when
   * the endpoint was the flow being drawn, that second declaration overrode the
   * titled one mermaid had already been given.
   */
  it("titles a junction endpoint that is a FLOW, and never re-declares the flow being drawn (T4)", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", title: "主旅程", traverses: ["L1"], crosses: ["J-x"] }) },
      { file: "b", node: flow({ id: "C2", title: "下游旅程" }) },
      { file: "c", node: loop({ id: "L1", title: "one" }) },
      { file: "d", node: junction({ id: "J-x", between: ["C1", "C2"] }) },
    ]);
    const mermaid = renderFlowMermaid(graph, "C1");

    expect(mermaid).toContain('C2["C2: 下游旅程"]');
    expect(mermaid).not.toContain('C2["C2: C2"]');
    // the flow under render keeps its own title and is declared exactly once
    expect(mermaid).toContain('C1["C1: 主旅程"]');
    expect(mermaid.split("\n").filter((l) => l.includes('C1["'))).toHaveLength(1);
    expect(mermaid).toContain('C1 -.->|"J-x: handoff (C1→C2)"| C2');
  });

  it("falls back to the bare id as a label when a referenced loop can't be resolved", () => {
    const { graph } = buildGraph([{ file: "a", node: flow({ id: "C1", traverses: ["L-GHOST"] }) }]);
    const mermaid = renderFlowMermaid(graph, "C1");
    expect(mermaid).toContain('L-GHOST["L-GHOST: L-GHOST"]');
  });

  it("skips drawing an edge for a junction whose `between` has fewer than 2 entries", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", crosses: ["J-x"] }) },
      { file: "b", node: junction({ id: "J-x", between: ["L1"] }) },
    ]);
    const mermaid = renderFlowMermaid(graph, "C1");
    expect(mermaid).not.toContain("-.->");
  });

  it("produces no crossing-edge section content when the flow has no junctions", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"] }) },
      { file: "b", node: loop({ id: "L1" }) },
    ]);
    const mermaid = renderFlowMermaid(graph, "C1");
    expect(mermaid).not.toContain("-.->");
  });

  it("escapes a title's double quotes (would otherwise close the label early) and collapses embedded newlines to a space (would otherwise split the one-line node declaration)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({ id: "C1", traverses: ["L1"] }),
      },
      { file: "b", node: loop({ id: "L1", title: 'has "quotes"\nand a newline' }) },
    ]);
    const mermaid = renderFlowMermaid(graph, "C1");
    expect(mermaid).toContain(`L1["L1: has 'quotes' and a newline"]`);
    // every node declaration is exactly one line — no raw newline snuck through
    const nodeLine = mermaid.split("\n").find((line) => line.includes('L1["'));
    expect(nodeLine).toBe(`  L1["L1: has 'quotes' and a newline"]`);
  });
});
