import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/loader/model-graph.js";
import { anchorFilesToResolve, computeConformance } from "../src/query/conformance.js";
import { affectedNodes } from "../src/query/diff.js";
import { evidenceOf } from "../src/query/queries.js";
import { sliceModel } from "../src/query/slice.js";
import type { Flow, Loop, Scenario } from "../src/schema/index.js";
import { FlowId, flowShape, isGradedFlow } from "../src/schema/model.js";
import { checkFlowScenarioIgnored, checkFlowShapeConsistency } from "../src/validate/checks.js";
import { coveredFiles } from "../src/validate/unregistered.js";
import { computeGraphModel } from "../src/views/graph-html.js";
import { computeOverviewModel } from "../src/views/overview-html.js";

/**
 * F1/F2b added a NEW code-binding channel — `Flow.anchors` / `Flow.scenarios` —
 * but only wired it into 2 of the consumers that read anchors. Every test here
 * pins one consumer that was blind to it, so the next field added to the schema
 * has a checklist to fail against rather than shipping half-connected.
 *
 * The fixture is the shape that exposed all of it: a flow-shaped repo (a CLI)
 * with ZERO loops, where flows are the only thing carrying code.
 */

function flow(overrides: Partial<Flow> & Pick<Flow, "id">): Flow {
  return {
    kind: "flow",
    title: "a flow",
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

function loop(overrides: Partial<Loop> & Pick<Loop, "id">): Loop {
  return {
    kind: "loop",
    title: "a loop",
    boundary: "b",
    owner: "o",
    status: "unverified",
    anchors: [],
    consumes_queues: [],
    scenarios: [],
    ...overrides,
  };
}

function scenario(overrides: Partial<Scenario> & Pick<Scenario, "id">): Scenario {
  return {
    kind: "scenario",
    given: "g",
    when: "w",
    // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the GWT domain vocabulary, not a thenable
    then: "t",
    level: "unit",
    verified_by: [],
    verified_by_text: [],
    ...overrides,
  };
}

/** Zero-loop CLI repo: C1 anchored + tested, C2 anchored + composes C1. */
function cliRepo() {
  const { graph } = buildGraph([
    {
      file: "a",
      node: flow({ id: "C1", anchors: ["src/install.ts#install"], scenarios: ["GWT-C1-001"] }),
    },
    {
      file: "b",
      node: flow({ id: "C2", references: ["C1"], anchors: ["src/update.ts#update"] }),
    },
    {
      file: "c",
      node: scenario({ id: "GWT-C1-001", verified_by: ["test/install.test.ts#t"] }),
    },
  ]);
  const files = new Set(anchorFilesToResolve(graph));
  return { graph, files, conformance: computeConformance(graph, { existingFiles: files }) };
}

describe("flow anchors reach every anchor consumer (F1 fan-out)", () => {
  it("reconcile registers flow-anchored files — they are not false `unregistered`", () => {
    // coveredFiles() drove `reconcile`'s unregistered report off loop+junction
    // anchors only, so in a flow-shaped repo EVERY anchored file read as
    // unregistered — an over-flag, which unregistered.ts's own doc forbids.
    const { graph } = cliRepo();
    expect([...coveredFiles(graph)].sort()).toEqual(["src/install.ts", "src/update.ts"]);
  });

  it("`check --diff` marks a flow affected when its anchored file changes", () => {
    const { graph } = cliRepo();
    expect(affectedNodes(graph, ["src/update.ts"])).toEqual([
      { nodeId: "C2", kind: "flow", anchor: "src/update.ts#update", file: "src/update.ts" },
    ]);
  });

  it("`evidence <flow>` reports the flow's own anchors and scenarios, not empty", () => {
    // evidenceOf is also MCP `model_evidence` — the one surface whose whole job
    // is answering "what is this node grounded in?". It returned nothing for an
    // anchored flow.
    const { graph } = cliRepo();
    expect(evidenceOf(graph, "C1")).toMatchObject({
      nodeId: "C1",
      kind: "flow",
      anchors: ["src/install.ts#install"],
      scenarios: ["GWT-C1-001"],
    });
  });

  it("`inspect <flow>` reaches the GWT guarding it (and the scenario reaches back)", () => {
    const { graph } = cliRepo();
    const forward = sliceModel(graph, "C1", 2);
    expect(forward?.nodes.map((n) => n.node.id)).toContain("GWT-C1-001");

    // reverse edge: from the scenario back to the flow that declares it
    const back = sliceModel(graph, "GWT-C1-001", 2);
    expect(back?.nodes.map((n) => n.node.id)).toContain("C1");
  });

  it("the conformance-colored graph paints a graded flow with its verdict, not grey", () => {
    const { graph, conformance } = cliRepo();
    const model = computeGraphModel(graph, conformance);
    const byId = new Map(model.nodes.map((n) => [n.id, n]));

    expect(byId.get("C1")?.cls).toBe("met"); // anchored + verified scenario
    expect(byId.get("C2")?.cls).toBe("partial"); // anchored, no scenario
    // and the graph summary must agree with the conformance headline
    expect({
      met: model.summary.met,
      partial: model.summary.partial,
      gap: model.summary.gap,
    }).toEqual(conformance.counts);
  });

  it("the overview report card's numbers are explained by flow cards", () => {
    // The zero-loop case: the card said "1 met / 1 partial" while `loops` was
    // empty and OverviewFlow carried no verdict — numbers with nothing on the
    // page accounting for them.
    const { graph, conformance, files } = cliRepo();
    const model = computeOverviewModel(graph, conformance, files);

    expect(model.loops).toEqual({});
    const verdicts = model.flows.map((f) => f.verdict).sort();
    expect(verdicts).toEqual(["met", "partial"]);
    expect({ met: model.summary.met, partial: model.summary.partial }).toEqual({
      met: 1,
      partial: 1,
    });
    // the flow's own anchors are the only substance a zero-loop card has
    expect(model.flows.find((f) => f.id === "C1")?.anchors).toEqual([
      expect.objectContaining({ ref: "src/install.ts#install", ok: true }),
    ]);
  });
});

describe("composition-only flow carrying its own scenarios is no longer silent", () => {
  /**
   * The trap: a real, verified GWT attached at the flow level is dropped
   * entirely (the flow is excluded from grading), while the loop it traverses
   * still reports `no-scenario`. The loop report is correct on its own terms —
   * what is new is believing you had closed that gap.
   */
  function compositionRepo() {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "b", node: flow({ id: "C1", traverses: ["L1"], scenarios: ["GWT-C1-001"] }) },
      { file: "c", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#t"] }) },
    ]);
    return graph;
  }

  it("emits a `flow-scenario-ignored` warning naming the dropped scenario", () => {
    const violations = checkFlowScenarioIgnored(compositionRepo());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "flow-scenario-ignored",
      severity: "warning",
      nodeId: "C1",
    });
    expect(violations[0]?.message).toContain("GWT-C1-001");
  });

  it("stays a warning, not an error — the model is not malformed", () => {
    // The right fix may be to change the grading rule rather than the model, so
    // this must not fail the build while that question is open.
    expect(checkFlowScenarioIgnored(compositionRepo())[0]?.severity).toBe("warning");
  });

  it("does not fire for a flow that has its own anchors (it IS graded)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      {
        file: "b",
        node: flow({
          id: "C1",
          traverses: ["L1"],
          anchors: ["src/c1.ts#run"],
          scenarios: ["GWT-C1-001"],
        }),
      },
      { file: "c", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#t"] }) },
    ]);
    expect(checkFlowScenarioIgnored(graph)).toEqual([]);
  });

  it("does not fire for a composition-only flow with no scenarios (nothing is dropped)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "b", node: flow({ id: "C1", traverses: ["L1"] }) },
    ]);
    expect(checkFlowScenarioIgnored(graph)).toEqual([]);
  });

  it("a composition-only flow still renders as `structural`, not a faked verdict", () => {
    const graph = compositionRepo();
    const conformance = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });
    const model = computeGraphModel(graph, conformance);
    expect(model.nodes.find((n) => n.id === "C1")?.cls).toBe("structural");
    expect(conformance.flowsExcluded).toBe(1);
  });
});

describe("Flow.shape — the field that stops the engine guessing (T1)", () => {
  it("derives `anchored` from anchors when shape is not declared (backward compatible)", () => {
    expect(flowShape(flow({ id: "C1", anchors: ["src/a.ts#a"] }))).toBe("anchored");
    expect(flowShape(flow({ id: "C2", traverses: ["L1"] }))).toBe("composed");
    expect(flowShape(flow({ id: "C3" }))).toBe("composed");
  });

  it("an explicit shape wins over the derivation", () => {
    // declaring `anchored` with no anchors yet is a legitimate intent — it
    // grades as a no-anchor gap rather than being quietly excluded.
    expect(flowShape(flow({ id: "C1", shape: "anchored", traverses: ["L1"] }))).toBe("anchored");
  });

  it("isGradedFlow: anchored is graded even when it also composes", () => {
    expect(isGradedFlow(flow({ id: "C1", anchors: ["src/a.ts#a"], references: ["C2"] }))).toBe(
      true,
    );
  });

  it("isGradedFlow: composition-only is excluded, bound-to-nothing is graded", () => {
    expect(isGradedFlow(flow({ id: "C1", traverses: ["L1"] }))).toBe(false);
    expect(isGradedFlow(flow({ id: "C2" }))).toBe(true); // composes nothing → graded as a gap
  });

  it("an explicitly `anchored` flow with no anchors is graded as a gap, not excluded", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "b", node: flow({ id: "C1", shape: "anchored", traverses: ["L1"] }) },
    ]);
    const c = computeConformance(graph, { existingFiles: new Set(["src/a.ts"]) });
    expect(c.flowsExcluded).toBe(0);
    expect(c.nodes.find((n) => n.id === "C1")).toMatchObject({ verdict: "gap", code: "missing" });
  });

  it("rejects `composed` + anchors as an error — the one self-contradicting combination", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", shape: "composed", anchors: ["src/a.ts#a"] }) },
    ]);
    const violations = checkFlowShapeConsistency(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ check: "flow-shape", severity: "error", nodeId: "C1" });
  });

  it("accepts every non-contradicting shape/anchor combination", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", shape: "anchored", anchors: ["src/a.ts#a"] }) },
      { file: "b", node: flow({ id: "C2", shape: "composed", references: ["C1"] }) },
      { file: "c", node: flow({ id: "C3", anchors: ["src/b.ts#b"] }) }, // undeclared
    ]);
    expect(checkFlowShapeConsistency(graph)).toEqual([]);
  });

  it("FlowId accepts more than 9 flows — a CLI models one flow per command", () => {
    expect(() => FlowId.parse("C42")).not.toThrow();
    expect(() => FlowId.parse("C10")).not.toThrow();
    expect(() => FlowId.parse("CX")).toThrow();
  });
});
