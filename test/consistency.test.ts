import { describe, expect, it } from "vitest";
import type { LoadResult } from "../src/loader/load-model.js";
import { type ModelEntry, buildGraph } from "../src/loader/model-graph.js";
import { sliceModel } from "../src/query/slice.js";
import type { DebtEntry, Flow, Junction, Loop, ModelNode } from "../src/schema/index.js";
import { Junction as JunctionSchema, junctionEndpointKind } from "../src/schema/model.js";
import { checkReferentialIntegrity } from "../src/validate/checks.js";
import { checkAnchorDuplicate, checkFreetextIdRef } from "../src/validate/consistency.js";
import { runT0 } from "../src/validate/t0.js";

/**
 * Cross-node consistency (Proposal 016 T3) + Junction.between expressiveness
 * (T4). The two checks exist because of two real incidents, and the tests below
 * are those incidents reduced to their smallest reproducing model:
 *
 *   D8 — one compaction behaviour modeled as both L4 and L10, the same
 *        `agent-session.ts#_checkCompaction` anchor claimed twice, `check`
 *        silent.
 *   D10 — a loop's notes saying "见 L4 auto-retry-backoff" while the behaviour
 *        lived in L3, surviving two review rounds.
 */

function loop(overrides: Partial<Loop> & Pick<Loop, "id">): Loop {
  return {
    kind: "loop",
    title: `title ${overrides.id}`,
    boundary: "boundary",
    owner: "owner",
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
    title: `title ${overrides.id}`,
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

function debt(overrides: Partial<DebtEntry> & Pick<DebtEntry, "id">): DebtEntry {
  return {
    kind: "debt",
    category: "dead_state_machine",
    subject: "subject",
    reality: "reality",
    ...overrides,
  };
}

const entries = (...nodes: ModelNode[]): ModelEntry[] =>
  nodes.map((node, i) => ({ node, file: `f${i}.yaml` }));

const graphOf = (...nodes: ModelNode[]) => buildGraph(entries(...nodes)).graph;

const loadOf = (...nodes: ModelNode[]): LoadResult => ({
  graph: graphOf(...nodes),
  entries: entries(...nodes),
  parseErrors: [],
  duplicateIds: [],
  singleNodeFiles: new Map(),
});

// ---------------------------------------------------------------- T3a

describe("checkAnchorDuplicate — one anchor, two owners (Proposal 016 T3a / D8)", () => {
  it("warns and names EVERY claimant when two loops anchor the same symbol", () => {
    const vs = checkAnchorDuplicate(
      graphOf(
        loop({ id: "L4", anchors: ["src/agent-session.ts#_checkCompaction"] }),
        loop({ id: "L10", anchors: ["src/agent-session.ts#_checkCompaction"] }),
      ),
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]?.check).toBe("anchor-duplicate");
    // Advisory on purpose: an existing model must not turn red on upgrade.
    expect(vs[0]?.severity).toBe("warning");
    expect(vs[0]?.message).toContain("L10");
    expect(vs[0]?.message).toContain("L4");
    expect(vs[0]?.message).toContain("src/agent-session.ts#_checkCompaction");
  });

  it("counts a flow's own anchors as claims too, not just loops'", () => {
    const vs = checkAnchorDuplicate(
      graphOf(loop({ id: "L1", anchors: ["a.ts#run"] }), flow({ id: "C1", anchors: ["a.ts#run"] })),
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]?.message).toContain("C1");
    expect(vs[0]?.message).toContain("L1");
  });

  it("does NOT warn when a junction's evidence cites a loop's anchor — that overlap is the design", () => {
    const vs = checkAnchorDuplicate(
      graphOf(
        loop({ id: "L1", anchors: ["a.ts#run"] }),
        junction({
          id: "J-x",
          between: ["L1", "L2"],
          evidence: [{ id: "e1", kind: "code", anchor: "a.ts#run" }],
        }),
      ),
    );
    expect(vs).toEqual([]);
  });

  it("does NOT warn when one node lists the same anchor twice — one node, one claim", () => {
    expect(
      checkAnchorDuplicate(graphOf(loop({ id: "L1", anchors: ["a.ts#run", "a.ts#run"] }))),
    ).toEqual([]);
  });

  it("does NOT fold near-miss spellings together — matching is on the exact anchor string", () => {
    expect(
      checkAnchorDuplicate(
        graphOf(
          loop({ id: "L1", anchors: ["a.ts#run"] }),
          loop({ id: "L2", anchors: ["a.ts#K.run"] }),
        ),
      ),
    ).toEqual([]);
  });

  it("does NOT warn when two loops share a TABLE anchor — a table is read and written by many", () => {
    expect(
      checkAnchorDuplicate(
        graphOf(
          loop({ id: "L1", anchors: ["sessions.status", "sessions"] }),
          loop({ id: "L2", anchors: ["sessions.status", "sessions"] }),
        ),
      ),
    ).toEqual([]);
  });

  it("reports anchors and claimant ids in sorted order (stable across runs)", () => {
    const vs = checkAnchorDuplicate(
      graphOf(
        loop({ id: "N9", anchors: ["z.ts#z", "a.ts#a"] }),
        loop({ id: "L2", anchors: ["z.ts#z", "a.ts#a"] }),
      ),
    );
    expect(vs.map((v) => v.message.match(/anchor "([^"]+)"/)?.[1])).toEqual(["a.ts#a", "z.ts#z"]);
    expect(vs[0]?.message).toContain("(L2, N9)");
  });
});

// ---------------------------------------------------------------- T3b

describe("checkFreetextIdRef — prose pointing at nothing (Proposal 016 T3b / D10)", () => {
  it("warns on a notes reference to a node that does not exist", () => {
    const vs = checkFreetextIdRef(graphOf(loop({ id: "L1", notes: "见 L99 auto-retry-backoff" })));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.check).toBe("freetext-id-ref");
    expect(vs[0]?.severity).toBe("warning");
    expect(vs[0]?.nodeId).toBe("L1");
    expect(vs[0]?.message).toContain('"L99"');
    expect(vs[0]?.message).toContain("L1.notes");
  });

  it("stays silent when the mentioned node exists", () => {
    expect(
      checkFreetextIdRef(graphOf(loop({ id: "L1" }), loop({ id: "L2", notes: "见 L1" }))),
    ).toEqual([]);
  });

  it("scans boundary as well as notes", () => {
    const vs = checkFreetextIdRef(graphOf(loop({ id: "L1", boundary: "hands off to N77" })));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.message).toContain("L1.boundary");
  });

  it("scans a flow's summary and risk_notes, a junction's title and a debt's prose", () => {
    const vs = checkFreetextIdRef(
      graphOf(
        flow({ id: "C1", summary: "runs C88", risk_notes: "shares state with L77" }),
        junction({ id: "J-x", between: ["L1"], title: "L1 ↔ N66" }),
        debt({ id: "DEBT-A", reality: "superseded by DEBT-ZZZ" }),
        loop({ id: "L1" }),
      ),
    );
    expect(vs.map((v) => v.message.match(/mentions "([^"]+)"/)?.[1]).sort()).toEqual([
      "C88",
      "DEBT-ZZZ",
      "L77",
      "N66",
    ]);
  });

  it("reports a nested scenario id ONCE, not also as the loop id inside it", () => {
    const vs = checkFreetextIdRef(graphOf(loop({ id: "L1", notes: "guarded by GWT-L99-001" })));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.message).toContain('"GWT-L99-001"');
  });

  it("dedupes repeated mentions of the same unknown id within one field", () => {
    const vs = checkFreetextIdRef(
      graphOf(loop({ id: "L1", notes: "L99 then L99 again, and L99" })),
    );
    expect(vs).toHaveLength(1);
  });

  it("does not match id-shaped text that runs into surrounding word characters", () => {
    expect(
      checkFreetextIdRef(graphOf(loop({ id: "L1", notes: "SL10 and L1abc and C1x" }))),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------- T3 wiring

describe("runT0 — cross-node consistency is wired into check", () => {
  it("surfaces both new checks as warnings without failing the run", async () => {
    const result = await runT0(
      loadOf(
        loop({ id: "L1", anchors: ["a.ts#run"], notes: "see L99" }),
        loop({ id: "L2", anchors: ["a.ts#run"] }),
      ),
    );
    expect(result.ok).toBe(true); // warnings never fail T0
    expect(result.violations.map((v) => v.check).sort()).toEqual([
      "anchor-duplicate",
      "freetext-id-ref",
    ]);
  });
});

// ---------------------------------------------------------------- T4

describe("Junction.between accepts a FlowId (Proposal 016 T4 / D3)", () => {
  it("parses a junction whose endpoints are a loop and a flow", () => {
    const j = JunctionSchema.parse({
      id: "J-loop-flow",
      kind: "junction",
      risk_class: "handoff",
      between: ["L1", "C1"],
    });
    expect(j.between).toEqual(["L1", "C1"]);
  });

  it("still rejects an endpoint that is neither a loop nor a flow id", () => {
    expect(() =>
      JunctionSchema.parse({
        id: "J-bad",
        kind: "junction",
        risk_class: "handoff",
        between: ["J-other"],
      }),
    ).toThrow();
  });

  it("junctionEndpointKind resolves each endpoint from its id shape alone", () => {
    expect(junctionEndpointKind("C42")).toBe("flow");
    expect(junctionEndpointKind("L1a")).toBe("loop");
    expect(junctionEndpointKind("N32")).toBe("loop");
  });

  it("passes referential integrity when the flow endpoint exists", () => {
    const vs = checkReferentialIntegrity(
      graphOf(
        loop({ id: "L1" }),
        flow({ id: "C1" }),
        junction({ id: "J-x", between: ["L1", "C1"] }),
      ),
    );
    expect(vs).toEqual([]);
  });

  it("errors — naming the FLOW kind, not loop — when the flow endpoint is dangling", () => {
    const vs = checkReferentialIntegrity(
      graphOf(loop({ id: "L1" }), junction({ id: "J-x", between: ["L1", "C99"] })),
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("error");
    expect(vs[0]?.message).toBe('J-x.between references "C99", which is not a defined flow');
  });

  it("slice reaches the flow endpoint with its real kind, and the flow reaches back", () => {
    const graph = graphOf(
      loop({ id: "L1" }),
      flow({ id: "C1" }),
      junction({ id: "J-x", between: ["L1", "C1"] }),
    );
    const fromJunction = sliceModel(graph, "J-x", 1);
    expect(fromJunction?.nodes.find((n) => n.id === "C1")?.kind).toBe("flow");
    // Reverse edge: `inspect C1` must surface the junction that names it.
    const fromFlow = sliceModel(graph, "C1", 1);
    expect(fromFlow?.nodes.map((n) => n.id).sort()).toEqual(["C1", "J-x"]);
  });
});
