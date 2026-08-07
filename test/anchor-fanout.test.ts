import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/loader/model-graph.js";
import { anchorFilesToResolve, computeConformance } from "../src/query/conformance.js";
import { affectedNodes } from "../src/query/diff.js";
import { evidenceOf } from "../src/query/queries.js";
import type { Flow, Junction, Loop, Scenario } from "../src/schema/index.js";
import { coveredFiles } from "../src/validate/unregistered.js";
import { computeGraphModel } from "../src/views/graph-html.js";
import { computeOverviewModel } from "../src/views/overview-html.js";

/**
 * T3 — the fan-out contract (Proposal 012 §4.3).
 *
 * `Flow.anchors` shipped wired into 2 of the ~8 places that read anchors; the
 * other 6 each became a user-visible bug. The root cause was not carelessness,
 * it was the absence of a CHECKLIST: nothing anywhere said "these are the
 * consumers a new anchor source must reach".
 *
 * This file is that checklist, executable. `ANCHOR_SOURCES` below enumerates
 * every schema field that can carry a code anchor. Add a new one to the schema,
 * add it here, and the assertions immediately tell you which consumers you have
 * not wired it into yet. Deleting a row to make the suite pass is the one thing
 * you must not do.
 *
 * The sibling contract for reference-shaped (id → id) fields lives in
 * `collectReferences` in src/validate/checks.ts, which carries the same warning.
 */

/** Every schema field that can carry a `path#symbol` code anchor. */
const ANCHOR_SOURCES = [
  { field: "Loop.anchors", file: "src/loop.ts", anchor: "src/loop.ts#L", ownerId: "L1" },
  { field: "Flow.anchors", file: "src/flow.ts", anchor: "src/flow.ts#F", ownerId: "C1" },
  {
    field: "Junction.evidence[].anchor",
    file: "src/junction.ts",
    anchor: "src/junction.ts#J",
    ownerId: "J-x",
  },
  {
    field: "Scenario.verified_by[]",
    file: "test/s.test.ts",
    anchor: "test/s.test.ts#S",
    ownerId: "GWT-C1-001",
  },
] as const;

function fixture() {
  const loopNode: Loop = {
    id: "L1",
    kind: "loop",
    title: "a loop",
    boundary: "b",
    owner: "o",
    status: "unverified",
    anchors: ["src/loop.ts#L"],
    consumes_queues: [],
    scenarios: [],
  };
  const anchoredFlow: Flow = {
    id: "C1",
    kind: "flow",
    title: "an anchored flow",
    traverses: [],
    guarded_by: [],
    crosses: [],
    references: [],
    anchors: ["src/flow.ts#F"],
    scenarios: ["GWT-C1-001"],
    status: "unverified",
  };
  const composedFlow: Flow = {
    id: "C2",
    kind: "flow",
    title: "a composed flow",
    traverses: ["L1"],
    guarded_by: [],
    crosses: [],
    references: [],
    anchors: [],
    scenarios: [],
    status: "unverified",
  };
  const junctionNode: Junction = {
    id: "J-x",
    kind: "junction",
    risk_class: "idempotency",
    between: ["L1"],
    scenarios: [],
    evidence: [{ id: "E1", kind: "code", anchor: "src/junction.ts#J" }],
    status: "unverified",
  };
  const scenarioNode: Scenario = {
    id: "GWT-C1-001",
    kind: "scenario",
    given: "g",
    when: "w",
    // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the GWT domain vocabulary, not a thenable
    then: "t",
    level: "unit",
    verified_by: ["test/s.test.ts#S"],
    verified_by_text: [],
  };

  const { graph } = buildGraph([
    { file: "l", node: loopNode },
    { file: "c1", node: anchoredFlow },
    { file: "c2", node: composedFlow },
    { file: "j", node: junctionNode },
    { file: "s", node: scenarioNode },
  ]);
  const files = new Set(ANCHOR_SOURCES.map((s) => s.file));
  return { graph, files, conformance: computeConformance(graph, { existingFiles: files }) };
}

describe("T3 — every anchor source reaches every anchor consumer", () => {
  it.each(ANCHOR_SOURCES)(
    "$field is resolved for file existence (anchorFilesToResolve)",
    ({ file }) => {
      expect(anchorFilesToResolve(fixture().graph)).toContain(file);
    },
  );

  it.each(ANCHOR_SOURCES.filter((s) => !s.field.startsWith("Scenario")))(
    "$field registers its file with reconcile (coveredFiles)",
    ({ file }) => {
      // Scenario.verified_by is deliberately NOT a registration: a test file
      // covering a loop does not make the test file itself modeled behavior.
      expect([...coveredFiles(fixture().graph)]).toContain(file);
    },
  );

  it.each(ANCHOR_SOURCES)(
    "$field makes its node show up in the diff impact surface (affectedNodes)",
    ({ file, ownerId }) => {
      const hits = affectedNodes(fixture().graph, [file]).map((n) => n.nodeId);
      expect(hits).toContain(ownerId);
    },
  );

  it.each(ANCHOR_SOURCES.filter((s) => s.field.endsWith(".anchors")))(
    "$field is reported as grounding by `evidence` / MCP model_evidence",
    ({ anchor, ownerId }) => {
      expect(evidenceOf(fixture().graph, ownerId)?.anchors).toContain(anchor);
    },
  );
});

describe("T3 — the views never contradict the conformance headline", () => {
  it("graph node colors are exactly the conformance verdicts", () => {
    const { graph, conformance } = fixture();
    const model = computeGraphModel(graph, conformance);
    for (const n of conformance.nodes) {
      expect(model.nodes.find((g) => g.id === n.id)?.cls).toBe(n.verdict);
    }
    // and nothing graded is painted as an ungraded shade
    expect({
      met: model.summary.met,
      partial: model.summary.partial,
      gap: model.summary.gap,
    }).toEqual(conformance.counts);
  });

  it("overview renders a verdict for EVERY graded node — loop, flow and junction", () => {
    // Junctions have no card of their own; they render as chips hanging off the
    // loops/flows they touch. Wherever a graded node surfaces, its verdict must
    // surface with it — otherwise the headline counts something the page cannot
    // explain, which is exactly the defect this suite exists to prevent.
    const { graph, conformance, files } = fixture();
    const model = computeOverviewModel(graph, conformance, files);
    const junctionChips = [
      ...Object.values(model.loops).flatMap((l) => l.junctions),
      ...model.flows.flatMap((f) => f.junctions),
    ];

    for (const n of conformance.nodes) {
      const shown =
        model.loops[n.id]?.verdict ??
        model.flows.find((f) => f.id === n.id)?.verdict ??
        junctionChips.find((j) => j.id === n.id)?.verdict;
      expect(shown, `${n.id} must render its verdict somewhere`).toBe(n.verdict);
    }
    expect(junctionChips.length, "the junction must actually be rendered").toBeGreaterThan(0);
  });

  it("every excluded flow is counted and rendered as ungraded, never as a verdict", () => {
    const { graph, conformance, files } = fixture();
    expect(conformance.flowsExcluded).toBe(1); // C2
    expect(computeOverviewModel(graph, conformance, files).summary.flowsExcluded).toBe(1);
    expect(computeGraphModel(graph, conformance).nodes.find((n) => n.id === "C2")?.cls).toBe(
      "structural",
    );
  });

  it("the graded set is exactly: non-dormant loops + junctions + graded flows", () => {
    const { conformance } = fixture();
    expect(conformance.nodes.map((n) => n.id).sort()).toEqual(["C1", "J-x", "L1"]);
    expect(conformance.graded).toBe(3);
  });
});
