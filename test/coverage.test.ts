import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCoverage } from "../src/cli/commands/coverage.js";
import { run } from "../src/cli/run.js";
import { buildGraph } from "../src/loader/model-graph.js";
import { computeCoverage, formatCoverage } from "../src/query/coverage.js";
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

describe("computeCoverage — counting rules", () => {
  it("counts anchors and scenarios as independent denominators over the same loops", () => {
    // The two are different questions: `anchors` is "does --strict-anchors
    // check this loop against the code", `scenarios` is "is its behavior
    // written down". A loop can have either, both, or neither.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      { file: "b", node: loop({ id: "L2", anchors: ["src/b.ts#B"] }) },
      { file: "c", node: loop({ id: "L3", scenarios: ["GWT-C1-001"] }) },
      { file: "d", node: loop({ id: "L4" }) },
      { file: "e", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);

    expect(coverage.loops).toBe(4);
    expect(coverage.loopsWithAnchors).toBe(2); // L1, L2
    expect(coverage.loopsWithScenarios).toBe(2); // L1, L3
  });

  it("counts an applies_to `nodes` selection as selector-only, not as attached coverage", () => {
    // `nodes` names the loop explicitly — more precise than owner_match, but
    // still resolved at query time and not written on the loop, so it belongs in
    // the same separate bucket. The output wording must not call this
    // "cross-cutting": it is per-loop, just not attached.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      {
        file: "b",
        node: scenario({
          id: "GWT-INV-002",
          level: "contract",
          applies_to: { nodes: ["L1"] },
        }),
      },
    ]);

    const coverage = computeCoverage(graph);

    expect(coverage.loopsWithScenarios).toBe(0);
    expect(coverage.loopsOnlyViaSelector).toBe(1);
    expect(formatCoverage(coverage).join("\n")).not.toContain("cross-cutting");
  });

  it("does NOT let a cross-cutting applies_to invariant count as per-loop scenario coverage", () => {
    // The whole point of the command. GWT-INV-001-style invariants select by
    // `owner_match`, so one of them can match most of a repo's loops — folding
    // that into loopsWithScenarios would report a C1-only model as fully covered.
    const { graph } = buildGraph([
      {
        file: "a",
        node: loop({ id: "L1", owner: "packages/control-plane", scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: loop({ id: "L2", owner: "packages/control-plane + apps/worker" }) },
      { file: "c", node: loop({ id: "L3", owner: "apps/frontend" }) },
      { file: "d", node: scenario({ id: "GWT-C1-001" }) },
      {
        file: "e",
        node: scenario({
          id: "GWT-INV-001",
          level: "contract",
          applies_to: { nodes: [], owner_match: "packages/control-plane" },
        }),
      },
    ]);

    const coverage = computeCoverage(graph);

    // L2 is matched by the invariant (substring containment on owner) but has
    // no scenario of its own — it must NOT be counted as covered.
    expect(coverage.loopsWithScenarios).toBe(1); // L1 only
    expect(coverage.loopsOnlyViaSelector).toBe(1); // L2, reported separately
    // L1 already has a direct scenario, so it never appears in the cross-cutting
    // bucket even though the invariant also matches its owner.
    expect(coverage.loops).toBe(3);
  });

  it("counts per-flow coverage over `traverses` only — guarded_by and references don't leak in", () => {
    // C1's covered loops must not make C4 look partially covered just because
    // C4 is guarded by, or references, something from C1.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1", "L2"] }) },
      {
        file: "b",
        node: flow({ id: "C4", traverses: ["L3"], guarded_by: ["L1"], references: ["C1"] }),
      },
      { file: "c", node: loop({ id: "L1", scenarios: ["GWT-C1-001"] }) },
      { file: "d", node: loop({ id: "L2" }) },
      { file: "e", node: loop({ id: "L3" }) },
      { file: "f", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const byId = new Map(computeCoverage(graph).flows.map((f) => [f.id, f]));

    expect(byId.get("C1")).toMatchObject({ loops: 2, loopsWithScenarios: 1 });
    expect(byId.get("C4")).toMatchObject({ loops: 1, loopsWithScenarios: 0 });
  });

  it("counts a loop traversed by two flows toward both", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"] }) },
      { file: "b", node: flow({ id: "C2", traverses: ["L1"] }) },
      { file: "c", node: loop({ id: "L1", scenarios: ["GWT-C1-001"] }) },
      { file: "d", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    for (const f of computeCoverage(graph).flows) {
      expect(f).toMatchObject({ loops: 1, loopsWithScenarios: 1 });
    }
  });

  it("treats a dangling traverses id as uncovered rather than crashing or inflating", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1", "L-GHOST"] }) },
      { file: "b", node: loop({ id: "L1", scenarios: ["GWT-C1-001"] }) },
      { file: "c", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    // A broken reference can only depress coverage (1/2), never inflate it.
    expect(computeCoverage(graph).flows[0]).toMatchObject({ loops: 2, loopsWithScenarios: 1 });
  });

  it("counts a zero-loop flow's OWN anchors/scenarios — the flow-shaped-repo case (#16)", () => {
    // A CLI-shaped repo (no loops at all) leans entirely on the flow's own F2a
    // anchor and F2b scenario — `traverses` is empty. `conformance` already
    // grades this flow on those own facts (gradeFlow); coverage must agree,
    // not report "0" for a flow conformance calls covered.
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C-cli",
          traverses: [],
          anchors: ["src/cli.ts#main"],
          scenarios: ["GWT-C1-001"],
        }),
      },
      { file: "b", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);

    expect(coverage.flowsWithAnchors).toBe(1);
    expect(coverage.flowsWithScenarios).toBe(1);
    const c = coverage.flows[0];
    expect(c).toMatchObject({
      id: "C-cli",
      loops: 0,
      loopsWithScenarios: 0,
      hasOwnAnchor: true,
      hasOwnScenario: true,
    });

    // The zero-loop flow must NOT be flagged "no behavior modeled" — its own
    // scenario covers it even though it traverses nothing.
    const out = formatCoverage(coverage).join("\n");
    expect(out).not.toContain("no behavior modeled");
    expect(out).toContain("C-cli");
    expect(out).toContain("[own: anchor✓ scenario✓]");
  });

  it("counts a mixed flow — traverses AND own anchors/scenarios differ, so each axis is checked independently", () => {
    // Deliberately distinct counts on every axis so an assertion that reads
    // the wrong field still fails (the #35 lesson: don't reuse a fixture
    // where every number happens to be equal).
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C-mixed",
          traverses: ["L1", "L2", "L3"],
          anchors: ["src/mixed.ts#glue"],
          scenarios: [],
        }),
      },
      { file: "b", node: loop({ id: "L1", scenarios: ["GWT-C1-001"] }) },
      { file: "c", node: loop({ id: "L2" }) },
      { file: "d", node: loop({ id: "L3" }) },
      { file: "e", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);
    const c = coverage.flows[0];

    // 3 traversed loops, only 1 has a scenario — unrelated to the flow's own
    // anchor, which is present but has no own scenario.
    expect(c).toMatchObject({
      loops: 3,
      loopsWithScenarios: 1,
      hasOwnAnchor: true,
      hasOwnScenario: false,
    });
    expect(coverage.flowsWithAnchors).toBe(1);
    expect(coverage.flowsWithScenarios).toBe(0);

    // Covered via the traversed loop (1/3 > 0), so no "uncovered" mark, but the
    // own-anchor bracket still shows (own anchor present, own scenario absent).
    const out = formatCoverage(coverage).join("\n");
    expect(out).toContain("C-mixed a flow: 1/3 [own: anchor✓ scenario✗]");
    expect(out).not.toContain("no behavior modeled");
  });

  it("keeps a dangling traverses id depressing-only even when the flow has its own scenario", () => {
    // The established principle (coverage.ts:97-100 era comment) is that a
    // dangling `traverses` id can only ever depress the traverses-based ratio,
    // never inflate it. Adding the own-anchor/scenario axis must not create a
    // backdoor where an own scenario silently "fixes" the broken ratio — the
    // two numbers stay independently honest. The flow here carries its own
    // ANCHOR too, so it is `anchored` (hence graded) — otherwise the own
    // scenario would be excluded on composition-only grounds, which is a
    // different rule tested separately below.
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C-dangling",
          traverses: ["L1", "L-GHOST", "L-GHOST-2"],
          anchors: ["src/cli.ts#main"],
          scenarios: ["GWT-C1-001"],
        }),
      },
      { file: "b", node: loop({ id: "L1" }) }, // no scenario
      { file: "c", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);
    const c = coverage.flows[0];

    // The dangling ids still inflate `loops` to 3 (claimed) but never
    // `loopsWithScenarios` (stays 0) — unaffected by the flow's own scenario.
    expect(c).toMatchObject({
      loops: 3,
      loopsWithScenarios: 0,
      hasOwnAnchor: true,
      hasOwnScenario: true,
    });

    // The flow is still reported as covered overall (own scenario), but the
    // traverses-based ratio itself (0/3) is untouched by that fact.
    const out = formatCoverage(coverage).join("\n");
    expect(out).toContain("C-dangling a flow: 0/3 [own: anchor✓ scenario✓]");
    expect(out).not.toContain("no behavior modeled");
  });

  it("reports own-anchor/scenario ratios over GRADED flows, the same denominator conformance uses", () => {
    // Numerator and denominator must come from the same population. Gating only
    // the numerator by `isGradedFlow` while dividing by every flow would leave
    // coverage and conformance disagreeing about the same model from the other
    // direction — 1/3 here vs "one flow graded, two excluded" there.
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({ id: "C-anchored", anchors: ["src/cli.ts#main"], scenarios: ["GWT-C1-001"] }),
      },
      { file: "b", node: flow({ id: "C-comp-1", traverses: ["L1"] }) },
      { file: "c", node: flow({ id: "C-comp-2", traverses: ["L1"] }) },
      { file: "d", node: loop({ id: "L1" }) },
      { file: "e", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);
    expect(coverage.flows).toHaveLength(3);
    expect(coverage.gradedFlows).toBe(1); // the two composition-only flows are excluded
    expect(coverage.flowsWithAnchors).toBe(1);
    expect(coverage.flowsWithScenarios).toBe(1);

    const out = formatCoverage(coverage).join("\n");
    expect(out).toContain("flows with own anchors:   1/1 (100%)");
    expect(out).toContain("flows with own scenarios: 1/1 (100%)");
    // The shrunken denominator must say WHY it shrank, never just shrink.
    expect(out).toContain("2 composition-only flow(s) excluded");
  });

  it("never lets the anchor numerator escape the graded denominator (1/0 or >100%)", () => {
    // An explicit `shape: composed` flow that ALSO carries its own anchors is a
    // T0 error — but `coverage` keeps reporting and exits 0 on an invalid
    // model by design, so it cannot lean on another command failing first.
    // `isGradedFlow` excludes this flow; counting its anchors anyway would
    // print `1/0` — a ratio that is not merely wrong but arithmetically
    // impossible, which is worse than a missing number.
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C-composed-with-anchors",
          shape: "composed",
          traverses: ["L1"],
          anchors: ["src/cli.ts#main"],
          scenarios: ["GWT-C1-001"],
        }),
      },
      { file: "b", node: loop({ id: "L1" }) },
      { file: "c", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);
    expect(coverage.gradedFlows).toBe(0);
    expect(coverage.flowsWithAnchors).toBe(0);
    expect(coverage.flowsWithScenarios).toBe(0);
    expect(coverage.flowsWithAnchors).toBeLessThanOrEqual(coverage.gradedFlows);
    expect(formatCoverage(coverage).join("\n")).not.toContain("1/0");
  });

  it("does NOT count a composition-only flow's own scenario — conformance ignores it and T0 warns about it", () => {
    // A flow that composes something but carries no anchor of its own is
    // excluded by `isGradedFlow`: `computeConformance` skips it entirely and
    // T0's `checkFlowScenarioIgnored` warns that its `scenarios` are ignored,
    // because its implementation IS its composed nodes, which are graded on
    // their own. Counting the scenario here would rebuild the exact
    // coverage↔conformance disagreement issue #16 exists to close, only
    // pointing the other way — and would wrongly suppress the "no behavior
    // modeled" marker for a flow whose traversed loop has no scenario at all.
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C-composition-only",
          traverses: ["L1"],
          scenarios: ["GWT-C1-001"], // ignored: no own anchor + composes
        }),
      },
      { file: "b", node: loop({ id: "L1" }) }, // no scenario
      { file: "c", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);
    expect(coverage.flows[0]).toMatchObject({ hasOwnAnchor: false, hasOwnScenario: false });
    // The per-flow field and the total must never disagree about the same flow.
    expect(coverage.flowsWithScenarios).toBe(0);

    const lines = formatCoverage(coverage);
    // Assert on the flow's OWN line, not the whole report — the section header
    // legitimately mentions `[own: ...]` while explaining the notation.
    const flowLine = lines.find((l) => l.includes("C-composition-only"));
    expect(flowLine).toBeDefined();
    // No `[own: ...]` bracket (nothing counted) and the marker is NOT suppressed.
    expect(flowLine).not.toContain("[own:");
    expect(flowLine).toContain("no behavior modeled");
  });

  it("deduplicates verified_by anchors — the anti-rot surface is distinct anchors, not references", () => {
    // Real models point many GWTs at the same test file+symbol; reporting the
    // reference count would overstate how much code the model is pinned to.
    const shared = "test/a.test.ts#Suite";
    const { graph } = buildGraph([
      { file: "a", node: scenario({ id: "GWT-C1-001", verified_by: [shared] }) },
      {
        file: "b",
        node: scenario({ id: "GWT-C1-002", verified_by: [shared, "test/b.test.ts#B"] }),
      },
      { file: "c", node: scenario({ id: "GWT-C1-003" }) }, // unverified by construction
    ]);

    const coverage = computeCoverage(graph);

    expect(coverage.scenarios).toBe(3);
    expect(coverage.scenariosVerified).toBe(2);
    expect(coverage.uniqueTestAnchors).toBe(2); // 3 references → 2 distinct anchors
  });

  it("counts junction scenario attachment separately from loops", () => {
    const { graph } = buildGraph([
      { file: "a", node: junction({ id: "J-a", between: ["L1"], scenarios: ["GWT-C1-001"] }) },
      { file: "b", node: junction({ id: "J-b", between: ["L1"] }) },
      { file: "c", node: loop({ id: "L1" }) },
      { file: "d", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const coverage = computeCoverage(graph);

    expect(coverage.junctions).toBe(2);
    expect(coverage.junctionsWithScenarios).toBe(1);
    // The junction's scenario does not make L1 a covered loop.
    expect(coverage.loopsWithScenarios).toBe(0);
  });

  it("reports n/a rather than dividing by zero on an empty model", () => {
    const { graph } = buildGraph([]);
    const coverage = computeCoverage(graph);

    expect(coverage).toMatchObject({ loops: 0, scenarios: 0, uniqueTestAnchors: 0, flows: [] });
    expect(formatCoverage(coverage).join("\n")).toContain("n/a");
  });
});

describe("formatCoverage — what a reader sees in the job summary", () => {
  it("flags a flow with zero modeled behavior explicitly instead of burying it in a ratio", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", title: "一次对话端到端", traverses: ["L1"] }) },
      { file: "b", node: flow({ id: "C4", title: "会话复活", traverses: ["L2", "L3"] }) },
      { file: "c", node: loop({ id: "L1", scenarios: ["GWT-C1-001"] }) },
      { file: "d", node: loop({ id: "L2" }) },
      { file: "e", node: loop({ id: "L3" }) },
      { file: "f", node: scenario({ id: "GWT-C1-001" }) },
    ]);

    const out = formatCoverage(computeCoverage(graph)).join("\n");

    expect(out).toContain("C1 一次对话端到端: 1/1");
    expect(out).toContain("C4 会话复活: 0/2 ← no behavior modeled");
    // A fully-covered flow gets no marker — the marker is a signal, not decoration.
    expect(out).not.toContain("C1 一次对话端到端: 1/1 ← no behavior modeled");
  });

  it("omits the selector line entirely when nothing is selected only via applies_to", () => {
    const { graph } = buildGraph([{ file: "a", node: loop({ id: "L1" }) }]);
    expect(formatCoverage(computeCoverage(graph)).join("\n")).not.toContain("applies_to selector");
  });

  it("leads with the parse-error warning, because a broken file can push percentages UP", () => {
    // Measured on the real seed: breaking one file moved 27/67 (40%) to 26/57
    // (46%). Dropping an unanchored loop shrinks the denominator, so "partial
    // load" is not a safe under-report — it must be stated, not footnoted.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "b", node: loop({ id: "L2" }) },
    ]);

    const lines = formatCoverage(computeCoverage(graph, 2));

    expect(lines[0]).toContain("2 model file(s) failed to parse");
    expect(lines[0]).toContain("may read HIGHER than reality");
    expect(lines[1]).toContain("model coverage:"); // headline still follows
    // Clean load says nothing.
    expect(formatCoverage(computeCoverage(graph)).join("\n")).not.toContain("failed to parse");
  });
});

describe("runCoverage / CLI — against a real seeded model (synthetic fixture)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "codeontic-coverage-test-"));
    await seedSyntheticModel(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reports real numbers for the synthetic seed model (3 loops incl. dormant, 1 flow, 1 junction, 1 scenario)", async () => {
    const result = await runCoverage(workDir);
    if (!result.ran) throw new Error(`coverage skipped: ${result.skippedReason}`);
    const { coverage } = result;

    // computeCoverage counts every Loop node regardless of `dormant` (that
    // distinction is unregistered.ts's concern, not coverage's) — L90, L90a,
    // N90 all count. All three carry anchors; only L90 carries a scenario.
    expect(coverage.loops).toBe(3);
    expect(coverage.loopsWithAnchors).toBe(3);
    expect(coverage.loopsWithScenarios).toBe(1);
    expect(coverage.junctions).toBe(1);
    expect(coverage.junctionsWithScenarios).toBe(1);
    expect(coverage.scenarios).toBe(1);
    expect(coverage.scenariosVerified).toBe(1);
  });

  it("exits 0 and prints the report through the CLI", async () => {
    const lines: string[] = [];
    const code = await run(["coverage", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(0); // advisory: coverage never fails a job
    const out = lines.join("\n");
    expect(out).toContain("model coverage: 3 loop(s), 1 junction(s), 1 scenario(s)");
    expect(out).toContain("loops with anchors:   3/3");
    expect(out).toContain("loops with scenarios: 1/3");
  });

  it("reports partial counts with a leading warning when SOME files fail to parse", async () => {
    // Regression guard for the direction that bites: a broken file drops loops
    // from the denominator, so the headline percentage can go UP. Measured here
    // rather than assumed.
    const before = await runCoverage(workDir);
    if (!before.ran) throw new Error("baseline coverage should have run");

    await writeFile(join(workDir, ".codeontic", "model", "loops", "main.yaml"), ":\n  - [unclosed");

    const after = await runCoverage(workDir);
    if (!after.ran) throw new Error("partial model should still report");

    expect(after.coverage.parseErrors).toBeGreaterThan(0);
    expect(after.coverage.loops).toBeLessThan(before.coverage.loops); // denominator shrank

    const lines: string[] = [];
    const code = await run(["coverage", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(0);
    expect(lines[0]).toContain("failed to parse");
    expect(lines[0]).toContain("may read HIGHER than reality");
  });

  it("skips (not 0/0) when EVERY model file fails to parse", async () => {
    // The dir existing doesn't make 0/0 a measurement. Per-file YAML/schema
    // failures never throw, so they sail past runCoverage's catch — without an
    // explicit check this prints a clean, entirely fictional "0 loop(s)".
    for (const rel of ["loops", "flows", "junctions", "scenarios", "baseline", "features"]) {
      await rm(join(workDir, ".codeontic", "model", rel), { recursive: true, force: true });
    }
    await mkdir(join(workDir, ".codeontic", "model", "loops"), { recursive: true });
    await writeFile(
      join(workDir, ".codeontic", "model", "loops", "broken.yaml"),
      ":\n  - [unclosed",
    );

    const result = await runCoverage(workDir);
    expect(result).toMatchObject({ ran: false });

    const lines: string[] = [];
    const code = await run(["coverage", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("⚠ coverage skipped:");
    expect(lines.join("\n")).not.toContain("model coverage: 0 loop(s)");
  });

  it("skips (not 0%) on a missing model dir, and still exits 0", async () => {
    // Coverage runs next to `check` in the same advisory job. A missing model is
    // check's failure to report — but reporting it here as "0 loops" would read
    // as a real measurement, so it must surface as an explicit skip instead.
    const empty = await mkdtemp(join(tmpdir(), "codeontic-coverage-empty-"));
    try {
      const result = await runCoverage(empty);
      expect(result.ran).toBe(false);

      const lines: string[] = [];
      const code = await run(["coverage", empty], {
        log: (m) => lines.push(m),
        error: (m) => lines.push(m),
      });

      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("⚠ coverage skipped:");
      expect(lines.join("\n")).not.toContain("model coverage: 0 loop(s)");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
