import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadModel } from "../src/loader/load-model.js";
import { evidenceOf, impactOf, planOf, scenarioDetail, testMatrix } from "../src/query/queries.js";
import { runQuery } from "../src/query/run-query.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

let workDir: string;

/**
 * Extra topology layered on the shared synthetic fixture (Proposal 010 — no
 * target-repo seed ships with this engine), purpose-built for this file's
 * query-function assertions:
 *   - C3 traverses [L93, L94, L95] with L93 guarded by L96 and referencing C4
 *     as a sub-flow — exercises planOf's steps/guards/subFlows/junction count.
 *   - GWT-INV-003 (contract, owner_match) applies to L94 without being
 *     hand-listed — exercises the applies_to → effectiveConstraints path in
 *     planOf and impactOf's reverse-dependent listing.
 *   - J-synth-third (between L93/L94) carries 2 evidence entries incl. one
 *     `issue` kind, and 2 scenario refs — exercises evidenceOf.
 *   - GWT-C3-001 (verified) / GWT-C3-002 (deliberately unverified, no
 *     verified_by) on C3 — exercises testMatrix's verified/unverified split.
 */
async function addExtraNodes(dir: string): Promise<void> {
  const modelDir = join(dir, ".codeontic", "model");
  await writeFile(
    join(modelDir, "loops", "extra.yaml"),
    [
      "- id: L93",
      "  kind: loop",
      "  title: 合成第三循环",
      "  boundary: b",
      '  owner: "packages/control-plane-query"',
      "  anchors: [src/synth/l93.ts#L93]",
      "  scenarios: [GWT-C3-001]",
      "",
      "- id: L94",
      "  kind: loop",
      "  title: 合成第四循环(owner_match 命中)",
      "  boundary: b",
      '  owner: "packages/control-plane-query-invariant"',
      "  anchors: [src/synth/l94.ts#L94]",
      "",
      "- id: L95",
      "  kind: loop",
      "  title: 合成第五循环",
      "  boundary: b",
      '  owner: "apps/worker"',
      "  anchors: [src/synth/l95.ts#L95]",
      "  scenarios: [GWT-C3-002]",
      "",
      "- id: L96",
      "  kind: loop",
      "  title: 合成守卫循环",
      "  boundary: b",
      '  owner: "apps/watchdog"',
      "  anchors: [src/synth/l96.ts#L96]",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "flows", "C3.yaml"),
    [
      "id: C3",
      "kind: flow",
      "title: 合成第三端到端流",
      "traverses: [L93, L94, L95]",
      "guarded_by: [L96]",
      "crosses: [J-synth-third]",
      "references: [C4]",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "flows", "C4.yaml"),
    ["id: C4", "kind: flow", "title: 合成子流", "traverses: [L95]"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "junctions", "J-synth-third.yaml"),
    [
      "id: J-synth-third",
      "kind: junction",
      "title: 合成第三风险点",
      "risk_class: failure_propagation",
      "between: [L93, L94]",
      "scenarios: [GWT-C3-001, GWT-INV-003]",
      "evidence:",
      "  - id: EV-Q-001",
      "    kind: code",
      "    anchor: src/synth/l93.ts#L93.check",
      "  - id: EV-Q-002",
      "    kind: issue",
      "    anchor: docs/issues.md#123",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "scenarios", "GWT-C3-001.yaml"),
    [
      "id: GWT-C3-001",
      "kind: scenario",
      "given: g",
      "when: w",
      "then: t",
      "level: integration",
      "verified_by: [test/synth/c3.test.ts#happy]",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "scenarios", "GWT-C3-002.yaml"),
    [
      "id: GWT-C3-002",
      "kind: scenario",
      "given: g2",
      "when: w2",
      "then: t2",
      "level: operational",
    ].join("\n"), // deliberately no verified_by — the honest operational gap
  );
  await writeFile(
    join(modelDir, "scenarios", "GWT-INV-003.yaml"),
    [
      "id: GWT-INV-003",
      "kind: scenario",
      "given: 合成不变式前提",
      "when: 任意匹配 owner 的循环运行",
      "then: 不变式成立",
      "level: contract",
      "applies_to:",
      '  owner_match: "packages/control-plane-query-invariant"',
    ].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-query-test-"));
  await seedSyntheticModel(workDir);
  await addExtraNodes(workDir);
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("query functions — pure, over a real seeded model", () => {
  it("impactOf: reverse dependents grouped by relation, undefined for unknown id", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const r = impactOf(graph, "L94");
    expect(r).toBeDefined();
    // C3 traverses L94; a junction sits between it; the invariant applies to it.
    expect(r?.dependents.some((d) => d.id === "C3" && d.relation === "traverses")).toBe(true);
    expect(r?.dependents.some((d) => d.id === "J-synth-third" && d.relation === "between")).toBe(
      true,
    );
    expect(r?.dependents.some((d) => d.id === "GWT-INV-003")).toBe(true);
    expect(impactOf(graph, "NOPE")).toBeUndefined();
  });

  it("planOf: the ordered flow sequence, guards, and crossing junctions", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const r = planOf(graph, "C3");
    expect(r?.steps.map((s) => s.loopId)).toEqual(["L93", "L94", "L95"]);
    expect(r?.guards.map((g) => g.loopId)).toEqual(["L96"]);
    expect(r?.junctions).toHaveLength(1);
    expect(r?.subFlows).toEqual(["C4"]);
    // effective constraints surface on the invariant-matched loop
    expect(r?.steps.find((s) => s.loopId === "L94")?.effectiveConstraints).toContain("GWT-INV-003");
    expect(planOf(graph, "L93")).toBeUndefined(); // not a flow
  });

  it("scenarioDetail: given/when/then + referrers + applies_to resolution", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const inv = scenarioDetail(graph, "GWT-INV-003");
    expect(inv?.scenario.level).toBe("contract");
    // the invariant applies to the matched loop via owner_match, not by hand-listing
    expect(inv?.appliesToLoops).toContain("L94");
    // a junction-referenced GWT reports its referrer
    const gwt = scenarioDetail(graph, "GWT-C3-001");
    expect(gwt?.referencedBy.some((x) => x.id === "J-synth-third" && x.kind === "junction")).toBe(
      true,
    );
    expect(scenarioDetail(graph, "NOPE")).toBeUndefined();
  });

  it("evidenceOf: junction evidence entries and loop anchors", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const j = evidenceOf(graph, "J-synth-third");
    expect(j?.evidence.length).toBe(2);
    expect(j?.evidence.some((e) => e.kind === "issue")).toBe(true);
    expect(j?.scenarios.length).toBeGreaterThan(0);
    const loop = evidenceOf(graph, "L94");
    expect(loop?.anchors.length).toBeGreaterThan(0);
    expect(loop?.evidence).toEqual([]); // loops carry anchors, not evidence entries
  });

  it("testMatrix: C3's GWT↔test coverage — exactly one deliberately-unverified (the operational gap)", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const m = testMatrix(graph, "C3");
    expect(m).toBeDefined();
    if (!m) return;
    // total = verified + unverified, and every row's `verified` matches verified_by
    expect(m.summary.total).toBe(m.rows.length);
    expect(m.summary.verified + m.summary.unverified).toBe(m.summary.total);
    for (const row of m.rows) expect(row.verified).toBe(row.verifiedBy.length > 0);
    // the one unverified GWT is the honest operational gap GWT-C3-002
    const unverified = m.rows.filter((r) => !r.verified);
    expect(unverified.map((r) => r.scenarioId)).toContain("GWT-C3-002");
    expect(testMatrix(graph, "L93")).toBeUndefined(); // not a flow
  });
});

describe("runQuery — end-to-end (summary + side-channel file)", () => {
  it("writes a staleness-stamped side-channel file and returns a summary for each command", async () => {
    for (const [command, id] of [
      ["impact", "L94"],
      ["plan", "C3"],
      ["scenario", "GWT-INV-003"],
      ["evidence", "J-synth-third"],
      ["matrix", "C3"],
    ] as const) {
      const r = await runQuery(workDir, command, id);
      expect(r.outputPath).toBe(join(workDir, ".codeontic", "ws", `${command}-${id}.md`));
      expect(r.summary).toContain(command);
      const written = await readFile(r.outputPath, "utf8");
      expect(written).toContain("<!-- codeontic-staleness-stamp");
    }
  });

  it("throws a clear unknown-id error naming the expected kind", async () => {
    await expect(runQuery(workDir, "plan", "NOPE")).rejects.toThrow(/unknown flow id "NOPE"/);
    await expect(runQuery(workDir, "impact", "NOPE")).rejects.toThrow(/unknown node id "NOPE"/);
  });
});
