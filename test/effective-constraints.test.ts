import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/loader/model-graph.js";
import {
  collectDanglingAppliesTo,
  ownerMatches,
  resolveApplicableScenarios,
  scenarioApplies,
} from "../src/query/effective-constraints.js";
import type { Loop, Scenario } from "../src/schema/index.js";

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

describe("ownerMatches", () => {
  it("treats a pattern with no '*' as substring containment, not a prefix anchor", () => {
    // the exact real-data case that motivated this design: L16's owner
    // doesn't have "packages/control-plane" as a prefix.
    const l16Owner =
      "canonical writer = packages/control-plane run-service;agent-worker 仅作事件源,events route 仅转发";
    expect(ownerMatches(l16Owner, "packages/control-plane")).toBe(true);
    expect(ownerMatches("apps/agent-worker", "packages/control-plane")).toBe(false);
  });

  it("treats '*' as any-length-any-char, matching ordered fragments anywhere in the string", () => {
    expect(
      ownerMatches(
        "packages/control-plane + apps/control-worker",
        "packages/control-plane*apps/control-worker",
      ),
    ).toBe(true);
    // wrong order must not match
    expect(
      ownerMatches(
        "apps/control-worker + packages/control-plane",
        "packages/control-plane*apps/control-worker",
      ),
    ).toBe(false);
  });

  it("intentionally does NOT anchor '*'-patterns to the full string — surrounding decoration is tolerated, same as the no-'*' case", () => {
    // this is a deliberate design choice (documented on ownerMatches),
    // not an oversight: anchoring would make '*'-patterns stricter than
    // plain-substring patterns for no benefit, since real owner values
    // routinely carry a prefix/suffix (see the L16 case above).
    expect(
      ownerMatches(
        "canonical writer = packages/control-plane run-service;apps/control-worker 仅作事件源",
        "packages/control-plane*apps/control-worker",
      ),
    ).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(ownerMatches("Packages/Control-Plane", "packages/control-plane")).toBe(false);
  });
});

describe("scenarioApplies", () => {
  it("matches via nodes (exact id, works for any kind)", () => {
    const { graph } = buildGraph([{ file: "a", node: loop({ id: "L1" }) }]);
    const inv = scenario({
      id: "GWT-INV-001",
      applies_to: { nodes: ["L1"], owner_match: undefined },
    });
    expect(scenarioApplies(inv, "L1", graph)).toBe(true);
    expect(scenarioApplies(inv, "L2", graph)).toBe(false);
  });

  it("matches via owner_match against Loop.owner", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", owner: "packages/control-plane" }) },
      { file: "b", node: loop({ id: "L2", owner: "apps/agent-worker" }) },
    ]);
    const inv = scenario({
      id: "GWT-INV-001",
      applies_to: { nodes: [], owner_match: "packages/control-plane" },
    });
    expect(scenarioApplies(inv, "L1", graph)).toBe(true);
    expect(scenarioApplies(inv, "L2", graph)).toBe(false);
  });

  it("never matches a dormant loop (owner: null) via owner_match — the null check short-circuits before any pattern is tried", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "N8", owner: null, dormant: true }) },
    ]);
    const inv = scenario({
      id: "GWT-INV-001",
      applies_to: { nodes: [], owner_match: "packages/control-plane" },
    });
    expect(scenarioApplies(inv, "N8", graph)).toBe(false);
  });

  it("combines nodes and owner_match with OR semantics", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", owner: "apps/agent-worker" }) }, // matches via nodes only
      { file: "b", node: loop({ id: "L2", owner: "packages/control-plane" }) }, // matches via owner_match only
      { file: "c", node: loop({ id: "L3", owner: "apps/gateway" }) }, // matches neither
    ]);
    const inv = scenario({
      id: "GWT-INV-001",
      applies_to: { nodes: ["L1"], owner_match: "packages/control-plane" },
    });
    expect(scenarioApplies(inv, "L1", graph)).toBe(true);
    expect(scenarioApplies(inv, "L2", graph)).toBe(true);
    expect(scenarioApplies(inv, "L3", graph)).toBe(false);
  });

  it("returns false when applies_to is absent (ordinary GWT, no propagation)", () => {
    const { graph } = buildGraph([{ file: "a", node: loop({ id: "L1" }) }]);
    const ordinary = scenario({ id: "GWT-C1-001" });
    expect(scenarioApplies(ordinary, "L1", graph)).toBe(false);
  });
});

describe("resolveApplicableScenarios", () => {
  it("returns every scenario whose applies_to matches the given node, query-time computed", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", owner: "packages/control-plane" }) },
      {
        file: "b",
        node: scenario({
          id: "GWT-INV-001",
          given: "INV-1",
          applies_to: { nodes: [], owner_match: "packages/control-plane" },
        }),
      },
      { file: "c", node: scenario({ id: "GWT-C1-001" }) }, // no applies_to, never resolved
      {
        file: "d",
        node: scenario({
          id: "GWT-INV-002",
          given: "other",
          applies_to: { nodes: ["L1"], owner_match: undefined },
        }),
      },
    ]);
    const applicable = resolveApplicableScenarios(graph, "L1")
      .map((s) => s.id)
      .sort();
    expect(applicable).toEqual(["GWT-INV-001", "GWT-INV-002"]);
  });
});

describe("collectDanglingAppliesTo", () => {
  it("flags an applies_to.nodes entry that references no defined node of any kind", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: scenario({ id: "GWT-INV-001", applies_to: { nodes: ["L-DOES-NOT-EXIST"] } }),
      },
    ]);
    const dangling = collectDanglingAppliesTo(graph);
    expect(dangling).toEqual([{ scenarioId: "GWT-INV-001", targetId: "L-DOES-NOT-EXIST" }]);
  });

  it("accepts a reference to any of the 6 kinds, not just Loop", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      {
        file: "b",
        node: scenario({ id: "GWT-INV-001", applies_to: { nodes: ["L1", "GWT-INV-001"] } }), // self-reference is fine here, just an existence check
      },
    ]);
    expect(collectDanglingAppliesTo(graph)).toEqual([]);
  });

  it("returns [] for scenarios with no applies_to", () => {
    const { graph } = buildGraph([{ file: "a", node: scenario({ id: "GWT-C1-001" }) }]);
    expect(collectDanglingAppliesTo(graph)).toEqual([]);
  });
});
