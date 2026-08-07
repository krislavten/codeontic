import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConformance } from "../src/cli/commands/conformance.js";
import { run } from "../src/cli/run.js";
import { buildGraph } from "../src/loader/model-graph.js";
import {
  type ConformanceInputs,
  anchorFilesToResolve,
  computeConformance,
  formatConformance,
} from "../src/query/conformance.js";
import type { Flow, Junction, Loop, Scenario } from "../src/schema/index.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

function loop(overrides: Partial<Loop> & Pick<Loop, "id">): Loop {
  return {
    kind: "loop",
    title: "a loop",
    boundary: "x→y",
    owner: "packages/example",
    status: "unverified",
    anchors: [],
    consumes_queues: [],
    scenarios: [],
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

function scenario(overrides: Partial<Scenario> & Pick<Scenario, "id">): Scenario {
  return {
    kind: "scenario",
    given: "g",
    when: "w",
    // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
    then: "t",
    level: "unit",
    verified_by: [],
    verified_by_text: [],
    ...overrides,
  };
}

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

/** Repo-resolved run where the listed files are the ones present on disk. */
function resolved(files: string[]): ConformanceInputs {
  return { existingFiles: new Set(files) };
}

describe("computeConformance — per-node verdicts", () => {
  it("grades a loop as `met` only when anchored AND its scenario is verified (files present)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });

    expect(c.counts).toEqual({ met: 1, partial: 0, gap: 0 });
    expect(c.nodes[0]).toMatchObject({ verdict: "met", code: "present", test: "present" });
    expect(c.gaps).toHaveLength(0);
    expect(c.repoResolved).toBe(true);
  });

  it("grades a loop with a code anchor but no scenario as `partial` (implemented, untested)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
    ]);

    const c = computeConformance(graph, { existingFiles: new Set(["src/a.ts"]) });

    expect(c.counts).toEqual({ met: 0, partial: 1, gap: 0 });
    expect(c.nodes[0]).toMatchObject({ verdict: "partial", code: "present", test: "missing" });
    expect(c.gaps).toEqual([expect.objectContaining({ nodeId: "L1", kind: "no-scenario" })]);
  });

  it("grades a loop with NO anchor as `gap` — declared behavior, no implementation binding", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", scenarios: ["GWT-C1-001"] }) },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(graph, resolved(["test/a.test.ts"]));

    expect(c.counts).toEqual({ met: 0, partial: 0, gap: 1 });
    expect(c.nodes[0]).toMatchObject({ verdict: "gap", code: "missing" });
    expect(c.gaps).toEqual([expect.objectContaining({ nodeId: "L1", kind: "no-anchor" })]);
  });

  it("flips a `met` loop to `gap` when its anchor file is absent under the repo", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/gone.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    // Only the test file exists; the anchor's src file does not.
    const c = computeConformance(graph, { existingFiles: new Set(["test/a.test.ts"]) });

    expect(c.nodes[0]).toMatchObject({ verdict: "gap", code: "missing" });
    expect(c.gaps).toEqual([
      expect.objectContaining({
        nodeId: "L1",
        kind: "anchor-missing",
        detail: expect.stringContaining("src/gone.ts"),
      }),
    ]);
  });

  it("flags a `test-missing` gap (partial) when the scenario's test file is absent", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/gone.test.ts#A"] }) },
    ]);

    const c = computeConformance(graph, { existingFiles: new Set(["src/a.ts"]) });

    expect(c.nodes[0]).toMatchObject({ verdict: "partial", code: "present", test: "missing" });
    expect(c.gaps).toEqual([expect.objectContaining({ nodeId: "L1", kind: "test-missing" })]);
  });

  it("flags a `scenario-unverified` gap when an attached scenario has empty verified_by", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001" }) }, // no verified_by
    ]);

    const c = computeConformance(graph, resolved(["src/a.ts"]));

    expect(c.nodes[0]).toMatchObject({ verdict: "partial", test: "missing" });
    expect(c.gaps).toEqual([
      expect.objectContaining({ nodeId: "L1", kind: "scenario-unverified" }),
    ]);
  });

  it("treats an UNGUARDED junction (no scenario) as a `gap`, not a partial", () => {
    // A modeled cross-loop risk with no test standing over it is the sharpest
    // implementation debt — the headline this view exists to surface.
    const { graph } = buildGraph([
      { file: "a", node: junction({ id: "J-x", between: ["L1", "L2"] }) },
      { file: "b", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "c", node: loop({ id: "L2", anchors: ["src/b.ts#B"] }) },
    ]);

    const c = computeConformance(graph, resolved(["src/a.ts", "src/b.ts"]));
    const j = c.nodes.find((n) => n.id === "J-x");

    expect(j).toMatchObject({ verdict: "gap", kind: "junction" });
    expect(c.gaps).toContainEqual(expect.objectContaining({ nodeId: "J-x", kind: "no-scenario" }));
  });

  it("grades a guarded junction `met` and flags a dangling evidence anchor as a gap", () => {
    const guarded = buildGraph([
      {
        file: "a",
        node: junction({
          id: "J-ok",
          between: ["L1", "L2"],
          scenarios: ["GWT-C1-001"],
          evidence: [{ id: "EV-1", kind: "code", anchor: "src/a.ts#h" }],
        }),
      },
      { file: "b", node: loop({ id: "L1" }) },
      { file: "c", node: loop({ id: "L2" }) },
      { file: "d", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]).graph;

    const met = computeConformance(guarded, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });
    expect(met.nodes.find((n) => n.id === "J-ok")).toMatchObject({ verdict: "met" });

    // Same junction, but the evidence file is gone → gap on the code axis.
    const broken = computeConformance(guarded, { existingFiles: new Set(["test/a.test.ts"]) });
    expect(broken.nodes.find((n) => n.id === "J-ok")).toMatchObject({
      verdict: "gap",
      code: "missing",
    });
    expect(broken.gaps).toContainEqual(
      expect.objectContaining({ nodeId: "J-ok", kind: "evidence-missing" }),
    );
  });

  it("flags a declared consumes_queues name that matches no extracted fact", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({
          id: "L1",
          anchors: ["src/a.ts#A"],
          scenarios: ["GWT-C1-001"],
          consumes_queues: ["order:process", "order:ghost"],
        }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
      queueFactNames: new Set(["order:process"]), // order:ghost is dangling
    });

    expect(c.queueChecked).toBe(true);
    expect(c.declaredQueueCount).toBe(2);
    // Anchored + verified, but a queue obligation is unmet → capped at partial.
    expect(c.nodes[0]).toMatchObject({ verdict: "partial" });
    expect(c.gaps).toEqual([
      expect.objectContaining({
        nodeId: "L1",
        kind: "queue-unmatched",
        detail: expect.stringContaining("order:ghost"),
      }),
    ]);
  });

  it("skips queue checking entirely when no adapter facts are supplied (absence is not a gap)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({
          id: "L1",
          anchors: ["src/a.ts#A"],
          scenarios: ["GWT-C1-001"],
          consumes_queues: ["order:process"],
        }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });

    expect(c.queueChecked).toBe(false);
    expect(c.declaredQueueCount).toBe(1);
    expect(c.nodes[0]).toMatchObject({ verdict: "met" }); // queue not checked ⇒ not held against it
  });

  it("excludes dormant loops from grading but counts them so the exclusion is visible", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      { file: "b", node: loop({ id: "N9", dormant: true, owner: null, anchors: ["src/n.ts#N"] }) },
      { file: "c", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });

    expect(c.graded).toBe(1);
    expect(c.dormantExcluded).toBe(1);
    expect(c.nodes.map((n) => n.id)).toEqual(["L1"]);
  });

  it("does NOT let an applies_to-selected scenario count as attached coverage", () => {
    // Same stance as coverage: only directly-attached scenarios count. A loop
    // selected only via a cross-cutting invariant is still untested here.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      {
        file: "b",
        node: scenario({
          id: "GWT-INV-001",
          level: "contract",
          verified_by: ["test/inv.test.ts#Inv"],
          applies_to: { nodes: ["L1"] },
        }),
      },
    ]);

    const c = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/inv.test.ts"]),
    });

    expect(c.nodes[0]).toMatchObject({ verdict: "partial", test: "missing" });
    expect(c.gaps).toContainEqual(expect.objectContaining({ nodeId: "L1", kind: "no-scenario" }));
  });

  it("does not crash on a scenario id that resolves to no node — treats it as unverified", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-GHOST-001"] }),
      },
    ]);

    const c = computeConformance(graph, { existingFiles: new Set(["src/a.ts"]) });

    expect(c.nodes[0]).toMatchObject({ verdict: "partial", test: "missing" });
    expect(c.gaps).toEqual([
      expect.objectContaining({
        nodeId: "L1",
        kind: "scenario-unverified",
        detail: expect.stringContaining("not a defined scenario"),
      }),
    ]);
  });
});

describe("computeConformance — structural (no repo root) mode", () => {
  it("trusts declared anchors/tests and marks the run unresolved", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/gone.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/gone.test.ts#A"] }) },
    ]);

    // No existingFiles: files are never stat'd, declarations trusted.
    const c = computeConformance(graph, {});

    expect(c.repoResolved).toBe(false);
    expect(c.nodes[0]).toMatchObject({ verdict: "met" }); // declared, not verified
    // No *-missing gaps can be emitted without a repo root.
    expect(c.gaps.filter((g) => g.kind === "anchor-missing" || g.kind === "test-missing")).toEqual(
      [],
    );
  });
});

/**
 * Proposal 016 T6 / D1 — the P0. Before this, an anchor whose file existed but
 * whose symbol had been renamed away left the score at `met code✓ test✓`, so a
 * pure rename could not move the report card at all. These lock in BOTH halves
 * of the fix: it downgrades when the evidence is gone, and (the half that
 * protects pi's 43/7/2) it does NOT downgrade on partial or unknown evidence.
 */
describe("computeConformance — stale anchors (symbol renamed away)", () => {
  /** Repo-resolved run where `files` exist and `stale` no longer name anything. */
  function withStale(files: string[], stale: string[]): ConformanceInputs {
    return { existingFiles: new Set(files), staleAnchors: new Set(stale) };
  }

  it("downgrades a loop's code axis when EVERY anchor went stale", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({
          id: "L1",
          anchors: ["src/a.ts#Gone", "src/b.ts#AlsoGone"],
          scenarios: ["GWT-C1-001"],
        }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(
      graph,
      withStale(["src/a.ts", "src/b.ts", "test/a.test.ts"], ["src/a.ts#Gone", "src/b.ts#AlsoGone"]),
    );

    expect(c.nodes[0]).toMatchObject({ verdict: "gap", code: "missing" });
    expect(c.gaps.map((g) => g.kind)).toEqual(["anchor-stale", "anchor-stale"]);
    expect(c.gaps[0]?.detail).toContain("src/a.ts#Gone");
  });

  it("keeps code✓ when only SOME anchors went stale — the node is still bound to real code", () => {
    // Unanimity, deliberately: this tier is whole-file text matching, not an
    // AST, so one stale name among several must not discredit the rest.
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({
          id: "L1",
          anchors: ["src/a.ts#Gone", "src/b.ts#StillHere"],
          scenarios: ["GWT-C1-001"],
        }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(
      graph,
      withStale(["src/a.ts", "src/b.ts", "test/a.test.ts"], ["src/a.ts#Gone"]),
    );

    expect(c.nodes[0]).toMatchObject({ verdict: "met", code: "present" });
    expect(c.gaps).toEqual([]);
  });

  it("disqualifies a scenario when ANY of its verified_by anchors went stale", () => {
    // The opposite rule from the code axis, on purpose: each verified_by entry
    // is a separate claim that a specific test covers this behavior.
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      {
        file: "b",
        node: scenario({
          id: "GWT-C1-001",
          verified_by: ["test/a.test.ts#StillHere", "test/a.test.ts#Gone"],
        }),
      },
    ]);

    const c = computeConformance(
      graph,
      withStale(["src/a.ts", "test/a.test.ts"], ["test/a.test.ts#Gone"]),
    );

    expect(c.nodes[0]).toMatchObject({ verdict: "partial", code: "present", test: "missing" });
    expect(c.gaps).toEqual([
      expect.objectContaining({
        kind: "test-stale",
        detail: 'scenario "GWT-C1-001" test anchor stale: test/a.test.ts#Gone',
      }),
    ]);
  });

  it("downgrades a junction whose every evidence anchor went stale", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      {
        file: "b",
        node: junction({
          id: "J-x",
          between: ["L1"],
          scenarios: ["GWT-C1-001"],
          evidence: [{ id: "EV", kind: "code", anchor: "src/a.ts#Gone" }],
        }),
      },
      { file: "c", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const c = computeConformance(
      graph,
      withStale(["src/a.ts", "test/a.test.ts"], ["src/a.ts#Gone"]),
    );

    const junctionNode = c.nodes.find((n) => n.id === "J-x");
    expect(junctionNode).toMatchObject({ verdict: "gap", code: "missing" });
  });

  it("never downgrades without a repo root — no staleAnchors means nothing is stale", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#Gone"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#Gone"] }) },
    ]);

    expect(computeConformance(graph, {}).nodes[0]).toMatchObject({ verdict: "met" });
  });
});

describe("computeConformance — execution strength of the evidence (D9)", () => {
  function graphWithLevels(...levels: Scenario["level"][]) {
    const ids = levels.map((_, i) => `GWT-C1-00${i + 1}`);
    return buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ids }) },
      ...levels.map((level, i) => ({
        file: `s${i}`,
        node: scenario({
          id: ids[i] as string,
          level,
          verified_by: ["test/a.test.ts#A"],
        }),
      })),
    ]).graph;
  }

  it("reports the distinct levels behind a test✓, sorted, without changing the verdict", () => {
    const c = computeConformance(
      graphWithLevels("unit", "integration", "unit"),
      resolved(["src/a.ts", "test/a.test.ts"]),
    );
    expect(c.nodes[0]).toMatchObject({ verdict: "met", testLevels: ["integration", "unit"] });
    expect(formatConformance(c).join("\n")).toContain("test✓ [integration,unit]");
  });

  it("flags e2e-only evidence — the green likeliest to come from a suite nobody ran", () => {
    const c = computeConformance(graphWithLevels("e2e"), resolved(["src/a.ts", "test/a.test.ts"]));
    expect(formatConformance(c).join("\n")).toContain("test✓ [e2e] (e2e-only evidence)");
  });

  it("does NOT flag e2e-only when other levels also stand behind the node", () => {
    const c = computeConformance(
      graphWithLevels("e2e", "unit"),
      resolved(["src/a.ts", "test/a.test.ts"]),
    );
    expect(formatConformance(c).join("\n")).not.toContain("e2e-only");
  });

  it("counts only scenarios that actually held up — a stale one contributes no level", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }),
      },
      {
        file: "b",
        node: scenario({ id: "GWT-C1-001", level: "e2e", verified_by: ["test/a.test.ts#Gone"] }),
      },
    ]);
    const c = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
      staleAnchors: new Set(["test/a.test.ts#Gone"]),
    });
    expect(c.nodes[0]).toMatchObject({ test: "missing", testLevels: [] });
  });
});

describe("formatConformance — coverage declaration (T5)", () => {
  const { graph } = buildGraph([
    { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A", "src/b.ts#B"] }) },
  ]);

  it("states the anchored-file count as a search-thoroughness proxy, above the score", () => {
    const lines = formatConformance(computeConformance(graph, resolved(["src/a.ts", "src/b.ts"])));
    const coverageLine = lines.findIndex((l) => l.includes("distinct repo file(s)"));
    const scoreLine = lines.findIndex((l) => l.startsWith("conformance:"));
    expect(lines[coverageLine]).toContain("model anchors reach 2 distinct repo file(s)");
    // Wording discipline (016 T5): a proxy for how hard the modelling pass
    // searched, explicitly NOT a completeness claim.
    expect(lines[coverageLine]).toContain("NOT business completeness");
    expect(coverageLine).toBeLessThan(scoreLine);
  });

  it("omits it without a repo root — there is nothing for the count to be a fraction of", () => {
    const lines = formatConformance(computeConformance(graph, {}));
    expect(lines.join("\n")).not.toContain("distinct repo file(s)");
  });
});

describe("anchorFilesToResolve — what the CLI stats", () => {
  it("collects loop anchors, junction evidence, and scenario verified_by (deduped, table anchors excluded)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A", "jobs_table.payload"] }) },
      {
        file: "b",
        node: junction({
          id: "J-x",
          between: ["L1"],
          evidence: [{ id: "EV", kind: "code", anchor: "src/a.ts#h" }], // same file, deduped
        }),
      },
      { file: "c", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    expect(anchorFilesToResolve(graph)).toEqual(["src/a.ts", "test/a.test.ts"]);
  });
});

describe("formatConformance — what a reader sees", () => {
  it("shows the headline counts, worst-first ordering, and a gap punch-list", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      { file: "b", node: loop({ id: "L2", scenarios: ["GWT-C1-001"] }) }, // no anchor → gap
      { file: "c", node: loop({ id: "L3", anchors: ["src/c.ts#C"] }) }, // no scenario → partial
      { file: "d", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);

    const out = formatConformance(
      computeConformance(graph, {
        existingFiles: new Set(["src/a.ts", "src/c.ts", "test/a.test.ts"]),
      }),
    );
    const text = out.join("\n");

    expect(text).toContain("conformance: 1 met / 1 partial / 1 gap (of 3 graded node(s))");
    // Worst-first: the gap (L2) is listed before the partial (L3) before the met (L1).
    const l1 = out.findIndex((l) => l.includes("L1"));
    const l2 = out.findIndex((l) => l.includes("L2"));
    const l3 = out.findIndex((l) => l.includes("L3"));
    expect(l2).toBeLessThan(l3);
    expect(l3).toBeLessThan(l1);
    expect(text).toContain("gaps (2):");
    expect(text).toContain("L2 — no code anchor");
    expect(text).toContain("L3 — unguarded (no scenario)");
  });

  it("leads with the unresolved-mode banner when no repo root was given", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
    ]);
    const lines = formatConformance(computeConformance(graph, {}));
    expect(lines[0]).toContain("NOT resolved against code");
    expect(lines[0]).toContain("--repo-root");
  });

  it("notes uncheckable queue obligations when no adapter is present", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", anchors: ["src/a.ts#A"], consumes_queues: ["order:process"] }),
      },
    ]);
    const out = formatConformance(
      computeConformance(graph, { existingFiles: new Set(["src/a.ts"]) }),
    ).join("\n");
    expect(out).toContain("consumes_queues obligation(s) NOT checked");
  });

  it("leads with the parse-error warning on a partial graph", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
    ]);
    const lines = formatConformance(computeConformance(graph, resolved(["src/a.ts"]), 2));
    expect(lines[0]).toContain("2 model file(s) failed to parse");
  });
});

describe("runConformance / CLI — against the synthetic seed model", () => {
  let workDir: string;

  /**
   * Write a file that MENTIONS the given symbols. Since T6 the report card
   * resolves anchors down to the symbol, so a fixture file has to carry the
   * names its anchors claim — a bare `// present` placeholder now (correctly)
   * reads as "the file is here and the code it named is gone".
   */
  async function touch(rel: string, ...symbols: string[]): Promise<void> {
    const abs = join(workDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(
      abs,
      `// present\n${symbols.map((s) => `export const ${s} = 1;`).join("\n")}\n`,
    );
  }

  /** Every file + symbol the synthetic model's anchors and tests point at. */
  async function touchAllAnchoredFiles(): Promise<void> {
    await touch("src/synth/main.ts", "SynthLoop");
    await touch("src/synth/dormant.ts", "DormantHandler");
    await touch("test/synth/handoff.test.ts", "handoff_happy_path");
    await touch("docs/synth-spec.md"); // not a TS/JS source — symbols unresolvable, never stale
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "codeontic-conformance-test-"));
    await seedSyntheticModel(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("resolves anchors/tests against a real checkout: L90 met, J-synth-handoff met", async () => {
    await touchAllAnchoredFiles();

    const result = await runConformance(workDir, { repoRoot: workDir });
    if (!result.ran) throw new Error(`conformance skipped: ${result.skippedReason}`);
    const { conformance } = result;

    expect(conformance.repoResolved).toBe(true);
    // L90 (anchored + verified scenario) and L90a (anchored, no scenario) are
    // graded; N90 is dormant and excluded. The junction is guarded + evidence resolves.
    expect(conformance.graded).toBe(3); // L90, L90a, J-synth-handoff
    expect(conformance.dormantExcluded).toBe(1); // N90
    const byId = new Map(conformance.nodes.map((n) => [n.id, n]));
    expect(byId.get("L90")).toMatchObject({ verdict: "met" });
    expect(byId.get("L90a")).toMatchObject({ verdict: "partial" }); // anchored, no scenario
    expect(byId.get("J-synth-handoff")).toMatchObject({ verdict: "met" });
  });

  it("turns a met node into a gap when its anchor file is deleted from the checkout", async () => {
    // Everything EXCEPT L90's main.ts — so L90's anchor no longer resolves.
    await touch("test/synth/handoff.test.ts", "handoff_happy_path");
    await touch("docs/synth-spec.md");

    const result = await runConformance(workDir, { repoRoot: workDir });
    if (!result.ran) throw new Error("should have run");
    const byId = new Map(result.conformance.nodes.map((n) => [n.id, n]));
    expect(byId.get("L90")).toMatchObject({ verdict: "gap", code: "missing" });
    expect(result.conformance.gaps).toContainEqual(
      expect.objectContaining({ nodeId: "L90", kind: "anchor-missing" }),
    );
  });

  it("exits 0 by default and prints the report through the CLI (structural, no repo root)", async () => {
    const lines: string[] = [];
    const code = await run(["conformance", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(0); // advisory
    const out = lines.join("\n");
    expect(out).toContain("NOT resolved against code"); // no --repo-root
    expect(out).toContain("conformance:");
    expect(out).toContain("dormant loop(s) excluded");
  });

  it("exits non-zero under --strict when gaps exist", async () => {
    // No anchor files created + strict → the unresolved structural run still
    // finds the model's own gaps (L90a has no scenario). Give it a repo root so
    // the missing files become real anchor gaps too.
    const lines: string[] = [];
    const code = await run(["conformance", workDir, "--repo-root", workDir, "--strict"], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("gaps (");
  });

  it("skips (not 0 graded) when the model dir is missing, and still exits 0", async () => {
    const empty = await mkdtemp(join(tmpdir(), "codeontic-conformance-empty-"));
    try {
      const result = await runConformance(empty);
      expect(result.ran).toBe(false);

      const lines: string[] = [];
      const code = await run(["conformance", empty], {
        log: (m) => lines.push(m),
        error: (m) => lines.push(m),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("⚠ conformance skipped:");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("computeConformance — flow grading (F2a code axis + F2b test axis)", () => {
  it("grades a flow `met` only when anchored AND its scenario is verified (F2b)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({ id: "C1", anchors: ["src/install.ts#install"], scenarios: ["S1"] }),
      },
      { file: "b", node: scenario({ id: "S1", verified_by: ["test/install.test.ts#t"] }) },
    ]);

    const c = computeConformance(graph, resolved(["src/install.ts", "test/install.test.ts"]));

    expect(c.counts).toEqual({ met: 1, partial: 0, gap: 0 });
    expect(c.flowsExcluded).toBe(0);
    expect(c.nodes[0]).toMatchObject({
      id: "C1",
      kind: "flow",
      verdict: "met",
      code: "present",
      test: "present",
    });
  });

  it("grades a code-anchored flow with NO scenario as `partial`, not `met` — anchored ≠ tested (F2b)", () => {
    // The correction F2b makes over the code-axis-only first cut: a flow that
    // binds to code but has no verified test is not fully conformant.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", anchors: ["src/install.ts#install"] }) },
    ]);

    const c = computeConformance(graph, resolved(["src/install.ts"]));

    expect(c.counts).toEqual({ met: 0, partial: 1, gap: 0 });
    expect(c.nodes[0]).toMatchObject({ verdict: "partial", code: "present", test: "missing" });
    expect(c.gaps).toEqual([expect.objectContaining({ nodeId: "C1", kind: "no-scenario" })]);
  });

  it("keeps a flow a `gap` when unanchored EVEN IF it has a verified scenario — code axis dominates", () => {
    // A passing test pointing elsewhere does not rescue an unbound implementation
    // claim (mirrors loops). Someone will ask "it has a test, why gap?" — this pins it.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", scenarios: ["S1"] }) }, // no anchors
      { file: "b", node: scenario({ id: "S1", verified_by: ["test/x.test.ts#t"] }) },
    ]);

    const c = computeConformance(graph, resolved(["test/x.test.ts"]));

    expect(c.counts).toEqual({ met: 0, partial: 0, gap: 1 });
    expect(c.nodes[0]).toMatchObject({ verdict: "gap", code: "missing" });
    expect(c.gaps).toEqual([expect.objectContaining({ nodeId: "C1", kind: "no-anchor" })]);
  });

  it("grades a flow whose own anchor file is absent as `gap` (anchor-missing) — proves flow anchors reach the resolve set", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", anchors: ["src/gone.ts#install"] }) },
    ]);
    // The CLI stats exactly anchorFilesToResolve(graph); if flow anchors were
    // omitted there, this file would be "resolved" by absence and wrongly pass.
    expect(anchorFilesToResolve(graph)).toContain("src/gone.ts");

    const c = computeConformance(graph, resolved([])); // src/gone.ts NOT present
    expect(c.counts).toEqual({ met: 0, partial: 0, gap: 1 });
    expect(c.nodes[0]).toMatchObject({ id: "C1", verdict: "gap", code: "missing" });
    // (also carries a no-scenario gap now — like loops; the code gap is what we assert here)
    expect(c.gaps).toContainEqual(
      expect.objectContaining({ nodeId: "C1", kind: "anchor-missing" }),
    );
  });

  it("EXCLUDES a composition-only flow (composes loops, no own anchors) — not graded, only counted", () => {
    // The common real-repo shape: a flow whose journey is made of already-graded loops.
    // Grading it "met" would double-count its loops' green and move the headline.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["S1"] }) },
      { file: "b", node: scenario({ id: "S1", verified_by: ["test/a.test.ts#A"] }) },
      { file: "c", node: flow({ id: "C1", traverses: ["L1"] }) },
    ]);

    const c = computeConformance(graph, resolved(["src/a.ts", "test/a.test.ts"]));

    expect(c.flowsExcluded).toBe(1);
    // graded nodes are the loop only — the flow is NOT among them.
    expect(c.nodes.map((n) => n.id)).toEqual(["L1"]);
    expect(c.nodes.some((n) => n.kind === "flow")).toBe(false);
  });

  it("grades a flow that composes AND declares own anchors (not excluded) — the reskill C2 case", () => {
    // C2 references C1 (composes) but also binds to its own update-specific code.
    // Declaring own anchors opts it INTO grading — its anchors are its own
    // contribution, not the composed flow's, so this is not double-counting.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", anchors: ["src/install.ts#install"] }) },
      {
        file: "b",
        node: flow({ id: "C2", references: ["C1"], anchors: ["src/update.ts#update"] }),
      },
    ]);

    const c = computeConformance(graph, resolved(["src/install.ts", "src/update.ts"]));

    expect(c.flowsExcluded).toBe(0); // C2 has own anchors → graded, NOT excluded
    // both graded (anchored); partial because neither has a scenario attached (F2b).
    expect(c.counts).toEqual({ met: 0, partial: 2, gap: 0 });
    expect(c.nodes.map((n) => n.id).sort()).toEqual(["C1", "C2"]);
  });

  it("grades a flow with NEITHER anchors NOR composition as `gap` (genuinely unbound)", () => {
    const { graph } = buildGraph([{ file: "a", node: flow({ id: "C1" }) }]);

    const c = computeConformance(graph, resolved([]));

    expect(c.flowsExcluded).toBe(0); // it composes nothing, so it is graded, not excluded
    expect(c.counts).toEqual({ met: 0, partial: 0, gap: 1 });
    expect(c.gaps).toContainEqual(expect.objectContaining({ nodeId: "C1", kind: "no-anchor" }));
  });

  /**
   * The don't-regress proof (advisor's bar): adding a composition-only
   * flow to a loop/junction model must NOT change the graded set, verdicts, or
   * counts at all — only bump `flowsExcluded`. Asserted as EQUALITY against the
   * same model without the flow, not just spot-checks.
   */
  it("adding a composition-only flow leaves loop/junction grading byte-identical (pure addition)", () => {
    const base = [
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["S1"] }) },
      { file: "b", node: loop({ id: "L2", anchors: ["src/b.ts#B"] }) },
      { file: "c", node: junction({ id: "J1", between: ["L1", "L2"], scenarios: ["S1"] }) },
      { file: "d", node: scenario({ id: "S1", verified_by: ["test/a.test.ts#A"] }) },
    ];
    const files = resolved(["src/a.ts", "src/b.ts", "test/a.test.ts"]);

    const before = computeConformance(buildGraph(base).graph, files);
    const after = computeConformance(
      buildGraph([...base, { file: "e", node: flow({ id: "C1", traverses: ["L1", "L2"] }) }]).graph,
      files,
    );

    // Same graded nodes, same verdicts, same headline — the flow changed nothing but the excluded count.
    expect(after.nodes).toEqual(before.nodes);
    expect(after.counts).toEqual(before.counts);
    expect(after.graded).toBe(before.graded);
    expect(after.flowsExcluded).toBe(before.flowsExcluded + 1);
  });

  it("formats a flow with a real test axis (test✓ when its scenario is verified)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({ id: "C1", anchors: ["src/install.ts#install"], scenarios: ["S1"] }),
      },
      { file: "b", node: scenario({ id: "S1", verified_by: ["test/install.test.ts#t"] }) },
    ]);
    const lines = formatConformance(
      computeConformance(graph, resolved(["src/install.ts", "test/install.test.ts"])),
    );
    expect(lines.some((l) => l.includes("C1") && l.includes("code✓") && l.includes("test✓"))).toBe(
      true,
    );
  });
});
