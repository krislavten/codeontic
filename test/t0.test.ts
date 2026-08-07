import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModel } from "../src/loader/load-model.js";
import type { LoadResult } from "../src/loader/load-model.js";
import { buildGraph } from "../src/loader/model-graph.js";
import type { Feature, Flow, Junction, Loop, Scenario } from "../src/schema/index.js";
import {
  checkAnchorExistence,
  checkAnchorFormat,
  checkBaselineOnlyDecreases,
  checkFilenameMatchesId,
  checkGraphAcyclic,
  checkReferentialIntegrity,
  runT0,
} from "../src/validate/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

describe("runT0 — orchestrator", () => {
  it("passes (ok: true, no violations) on a valid model with no repoRoot given", async () => {
    const load = await loadModel(join(fixtures, "valid-model"));
    const result = await runT0(load);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails on schema errors and reports them without throwing", async () => {
    const load = await loadModel(join(fixtures, "broken-model"));
    const result = await runT0(load);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.check === "schema")).toBe(true);
  });

  it("fails on duplicate ids", async () => {
    const load = await loadModel(join(fixtures, "duplicate-id-model"));
    const result = await runT0(load);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.check === "id-uniqueness")).toBe(true);
  });
});

describe("checkFilenameMatchesId — file-per-node naming (Decision 004 技术点 3 / A7)", () => {
  const mkLoad = (singleNodeFiles: Map<string, string>): LoadResult => ({
    graph: buildGraph([]).graph,
    entries: [],
    parseErrors: [],
    duplicateIds: [],
    singleNodeFiles,
  });

  it("warns (not errors) when a single-node file's stem doesn't equal its id", () => {
    const vs = checkFilenameMatchesId(mkLoad(new Map([["junctions/J-foo.yaml", "J-bar"]])));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.check).toBe("filename-id");
    expect(vs[0]?.severity).toBe("warning"); // advisory: model still loads correctly
    expect(vs[0]?.nodeId).toBe("J-bar");
  });

  it("passes when the filename stem equals the id (both .yaml and .yml)", () => {
    expect(checkFilenameMatchesId(mkLoad(new Map([["junctions/J-foo.yaml", "J-foo"]])))).toEqual(
      [],
    );
    expect(checkFilenameMatchesId(mkLoad(new Map([["loops/L1.yml", "L1"]])))).toEqual([]);
  });

  it("exempts array files: a real seeded model (loops/*.yaml group many ids) produces no filename-id warning", async () => {
    const seedDir = join(__dirname, "fixtures", "synthetic-model");
    const load = await loadModel(seedDir);
    // loops/main.yaml holds L90/L90a/N90 — none is in singleNodeFiles, so no false flag.
    expect(load.singleNodeFiles.has("loops/main.yaml")).toBe(false);
    expect(checkFilenameMatchesId(load)).toEqual([]);
  });
});

describe("checkAnchorFormat", () => {
  it("flags a malformed anchor on a Loop as a blocking error", () => {
    const { graph } = buildGraph([
      {
        file: "x.yaml",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["!!! not an anchor"],
          consumes_queues: [],
          scenarios: [],
        },
      },
    ]);
    const violations = checkAnchorFormat(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("error");
  });
});

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
    status: "unverified",
    traverses: [],
    guarded_by: [],
    crosses: [],
    references: [],
    anchors: [],
    scenarios: [],
    ...overrides,
  };
}

function junction(
  overrides: Partial<Junction> & Pick<Junction, "id" | "risk_class" | "between">,
): Junction {
  return {
    kind: "junction",
    status: "unverified",
    scenarios: [],
    evidence: [],
    ...overrides,
  };
}

function feature(overrides: Partial<Feature> & Pick<Feature, "id">): Feature {
  return {
    kind: "feature",
    title: "x",
    status: "unverified",
    contains: [],
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

describe("checkReferentialIntegrity", () => {
  it("flags a Flow.traverses entry that has a valid LoopId shape but names no real Loop", () => {
    // reproduces the exact gap an independent review found: a reference
    // that matches the id regex but was never actually defined slipped
    // through with zero violations before this check existed.
    const { graph } = buildGraph([
      { file: "x.yaml", node: loop({ id: "L1" }) },
      { file: "y.yaml", node: flow({ id: "C1", traverses: ["L1", "L99"] }) },
    ]);
    const violations = checkReferentialIntegrity(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "referential-integrity",
      severity: "error",
      nodeId: "C1",
    });
    expect(violations[0]?.message).toContain("L99");
  });

  it("flags a Flow.scenarios entry that names no real Scenario (F2b: new referencing field, must be wired)", () => {
    // Flow.scenarios was added in F2b; a dangling scenario id must fail T0, not
    // slip through to be quietly reported as a `scenario-unverified` conformance gap.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", anchors: ["src/x.ts#x"], scenarios: ["GWT-NOPE"] }) },
    ]);
    const violations = checkReferentialIntegrity(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "referential-integrity",
      severity: "error",
      nodeId: "C1",
    });
    expect(violations[0]?.message).toContain("GWT-NOPE");
  });

  it("passes when every reference across all node kinds resolves", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      { file: "b", node: loop({ id: "L1a", parent: "L1" }) },
      { file: "c", node: flow({ id: "C1", traverses: ["L1"], guarded_by: ["L1a"] }) },
      { file: "d", node: flow({ id: "C2", references: ["C1"] }) },
      { file: "e", node: junction({ id: "J-x", risk_class: "handoff", between: ["L1"] }) },
      { file: "f", node: feature({ id: "F-x", contains: ["C1"] }) },
    ]);
    expect(checkReferentialIntegrity(graph)).toEqual([]);
  });

  it("flags a dangling Junction.between and Loop.parent reference", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1a", parent: "L1-DOES-NOT-EXIST" }) },
      { file: "b", node: junction({ id: "J-x", risk_class: "watchdog", between: ["L-NOPE"] }) },
    ]);
    const violations = checkReferentialIntegrity(graph);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.nodeId).sort()).toEqual(["J-x", "L1a"]);
  });

  it("flags a dangling Scenario.applies_to.nodes reference (Decision 004 technical point 2: wired into this check, not a separate one)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      {
        file: "b",
        node: scenario({ id: "GWT-INV-001", applies_to: { nodes: ["L1", "L-DOES-NOT-EXIST"] } }),
      },
    ]);
    const violations = checkReferentialIntegrity(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "referential-integrity",
      severity: "error",
      nodeId: "GWT-INV-001",
    });
    expect(violations[0]?.message).toContain("L-DOES-NOT-EXIST");
  });

  it("does not flag a Scenario.applies_to.nodes reference to a non-Loop kind — it's valid against all 6 kinds", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1" }) },
      { file: "b", node: scenario({ id: "GWT-INV-002", applies_to: { nodes: ["C1"] } }) },
    ]);
    expect(checkReferentialIntegrity(graph)).toEqual([]);
  });
});

describe("checkGraphAcyclic", () => {
  it("flags a Loop.parent cycle (two-node)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1a", parent: "L1b" }) },
      { file: "b", node: loop({ id: "L1b", parent: "L1a" }) },
    ]);
    const violations = checkGraphAcyclic(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ check: "graph-acyclic", severity: "error" });
    expect(violations[0]?.message).toContain("L1a");
    expect(violations[0]?.message).toContain("L1b");
  });

  it("flags a Loop.parent self-reference", () => {
    const { graph } = buildGraph([{ file: "a", node: loop({ id: "L1a", parent: "L1a" }) }]);
    const violations = checkGraphAcyclic(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("L1a -> L1a");
  });

  it("flags a Flow.references cycle (three-node)", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", references: ["C2"] }) },
      { file: "b", node: flow({ id: "C2", references: ["C3"] }) },
      { file: "c", node: flow({ id: "C3", references: ["C1"] }) },
    ]);
    const violations = checkGraphAcyclic(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/C1.*C2.*C3.*C1|C2.*C3.*C1.*C2|C3.*C1.*C2.*C3/);
  });

  it("does not flag a legitimate parent tree or acyclic flow references (the real seed's shape)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      { file: "b", node: loop({ id: "L1a", parent: "L1" }) },
      { file: "c", node: loop({ id: "L1b", parent: "L1" }) },
      { file: "d", node: flow({ id: "C1", references: ["C2", "C3"] }) },
      { file: "e", node: flow({ id: "C2" }) },
      { file: "f", node: flow({ id: "C3" }) },
    ]);
    expect(checkGraphAcyclic(graph)).toEqual([]);
  });

  it("does not report the same cycle twice when entered from two different starting nodes", () => {
    // L1a and L1b are both entry points DFS could start from — the cycle
    // between them must be reported once, not twice.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1a", parent: "L1b" }) },
      { file: "b", node: loop({ id: "L1b", parent: "L1a" }) },
      { file: "c", node: loop({ id: "L1c" }) }, // unrelated, acyclic
    ]);
    expect(checkGraphAcyclic(graph)).toHaveLength(1);
  });
});

describe("checkAnchorExistence", () => {
  it("is advisory (warning) by default when a file doesn't exist", async () => {
    const { graph } = buildGraph([
      {
        file: "x.yaml",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["does/not/exist.ts#Nope"],
          consumes_queues: [],
          scenarios: [],
        },
      },
    ]);
    const violations = await checkAnchorExistence(graph, process.cwd());
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("warning");
  });

  it("passes for an anchor whose file genuinely exists under repoRoot", async () => {
    const { graph } = buildGraph([
      {
        file: "x.yaml",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["package.json#N/A"],
          consumes_queues: [],
          scenarios: [],
        },
      },
    ]);
    const violations = await checkAnchorExistence(graph, process.cwd());
    expect(violations).toEqual([]);
  });

  it("skips table-style anchors entirely (nothing to resolve on disk)", async () => {
    const { graph } = buildGraph([
      {
        file: "x.yaml",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["worker_protocol_jobs.payload"],
          consumes_queues: [],
          scenarios: [],
        },
      },
    ]);
    const violations = await checkAnchorExistence(graph, process.cwd());
    expect(violations).toEqual([]);
  });
});

describe("checkBaselineOnlyDecreases", () => {
  it("passes when after is a subset of before (debt paid down)", () => {
    const before = new Set(["DEBT-A", "DEBT-B"]);
    const after = new Set(["DEBT-A"]);
    expect(checkBaselineOnlyDecreases(before, after)).toEqual([]);
  });

  it("passes when after equals before (steady state)", () => {
    const before = new Set(["DEBT-A", "DEBT-B"]);
    const after = new Set(["DEBT-A", "DEBT-B"]);
    expect(checkBaselineOnlyDecreases(before, after)).toEqual([]);
  });

  it("fails when after introduces an id not present in before", () => {
    const before = new Set(["DEBT-A"]);
    const after = new Set(["DEBT-A", "DEBT-NEW"]);
    const violations = checkBaselineOnlyDecreases(before, after);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("error");
    expect(violations[0]?.nodeId).toBe("DEBT-NEW");
  });
});
