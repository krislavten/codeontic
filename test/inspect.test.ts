import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInspect } from "../src/cli/commands/inspect.js";
import { run } from "../src/cli/run.js";
import { loadModel } from "../src/loader/load-model.js";
import { sliceModel } from "../src/query/slice.js";
import { summarizeSlice } from "../src/query/summary.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

let workDir: string;

/**
 * Extra nodes layered on top of the shared synthetic fixture (Proposal 010 —
 * no target-repo seed ships with this engine), purpose-built for the
 * BFS/effective-constraints/evidence-count assertions this file exercises:
 *   - C2 traverses [L91, L92] AND crosses J-synth-second (whose `between`
 *     also includes L92) — L92 is reachable at depth 1 (direct traverse) AND
 *     depth 2 (via the junction); BFS must record the shortest.
 *   - GWT-INV-002 applies via `owner_match` (not hand-listed on any loop)
 *     — L91's owner matches, L92's does not, so the effective-constraints
 *     resolution is selective, not blanket.
 *   - J-synth-second carries 3 evidence entries and 2 scenario references,
 *     for the summarizeSlice evidence/scenario count assertion.
 */
async function addExtraNodes(dir: string): Promise<void> {
  const modelDir = join(dir, ".codeontic", "model");
  await writeFile(
    join(modelDir, "loops", "extra.yaml"),
    [
      "- id: L91",
      "  kind: loop",
      "  title: 合成第二循环(owner_match 命中)",
      "  boundary: b",
      '  owner: "packages/control-plane-like-owner"',
      "  anchors: [src/synth/l91.ts#L91]",
      "",
      "- id: L92",
      "  kind: loop",
      "  title: 合成第三循环(owner_match 不命中)",
      "  boundary: b",
      '  owner: "apps/worker-owned"',
      "  anchors: [src/synth/l92.ts#L92]",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "flows", "C2.yaml"),
    [
      "id: C2",
      "kind: flow",
      "title: 合成第二端到端流",
      "traverses: [L91, L92]",
      "crosses: [J-synth-second]",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "junctions", "J-synth-second.yaml"),
    [
      "id: J-synth-second",
      "kind: junction",
      "title: 合成第二风险点",
      "risk_class: idempotency",
      "between: [L91, L92]",
      "scenarios: [GWT-L90-001, GWT-INV-002]",
      "evidence:",
      "  - id: EV-EXTRA-001",
      "    kind: code",
      "    anchor: src/synth/l91.ts#L91.check",
      "  - id: EV-EXTRA-002",
      "    kind: code",
      "    anchor: src/synth/l92.ts#L92.check",
      "  - id: EV-EXTRA-003",
      "    kind: test",
      "    anchor: test/synth/second.test.ts#check",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "scenarios", "GWT-INV-002.yaml"),
    [
      "id: GWT-INV-002",
      "kind: scenario",
      "given: 合成不变式前提",
      "when: 任意匹配 owner 的循环运行",
      "then: 不变式成立",
      "level: contract",
      "applies_to:",
      '  owner_match: "packages/control-plane-like"',
    ].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-inspect-test-"));
  await seedSyntheticModel(workDir);
  await addExtraNodes(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runInspect — real seeded model end-to-end", () => {
  it("slices C2 to depth 2, writes a staleness-stamped side-channel file, returns a summary", async () => {
    const result = await runInspect(workDir, "C2");

    expect(result.outputPath).toBe(join(workDir, ".codeontic", "ws", "inspect-C2.md"));
    expect(result.staleWarning).toBeUndefined(); // fresh run, no prior file

    // Summary keeps skeletons for the structural nodes...
    expect(result.summary).toContain("inspect C2 (flow) — depth 2");
    expect(result.summary).toContain("J-synth-second");
    expect(result.summary).toContain("[idempotency/unverified]");
    // ...and truncates the prose into the side-channel file.
    expect(result.summary).toContain("evidence/scenario detail truncated");

    const written = await readFile(result.outputPath, "utf8");
    expect(written).toContain("<!-- codeontic-staleness-stamp");
    expect(written).toContain("model_content_hash:");
    // Full detail present in the file, not the summary.
    expect(written).toContain("合成第二风险点"); // junction title
    expect(written).toContain("effective constraints (applies_to): GWT-INV-002");
  });

  it("resolves effective constraints: the owner_match invariant appears in the slice of a matching loop", async () => {
    const result = await runInspect(workDir, "L91", { depth: 1 });
    // GWT-INV-002 is not hand-listed on L91 — it's pulled in via applies_to.owner_match.
    expect(result.summary).toContain("GWT-INV-002");
  });

  it("rejects an unknown node id without writing a file (exit path)", async () => {
    await expect(runInspect(workDir, "NOPE")).rejects.toThrow(/unknown node id "NOPE"/);
    await expect(readFile(join(workDir, ".codeontic", "ws", "inspect-NOPE.md"))).rejects.toThrow();
  });

  it("at depth 0 returns only the root and surfaces the rest as frontier pointers", async () => {
    const result = await runInspect(workDir, "C2", { depth: 0 });
    expect(result.summary).toContain("depth 0, 1 node(s)");
    expect(result.summary).toMatch(/node\(s\) beyond depth 0 not expanded \(use --depth/);
  });

  it("actively warns when a pre-existing side-channel file is stale (Decision 004 技术点 4 consumer)", async () => {
    // First run writes inspect-L92.md stamped at the current model hash.
    const first = await runInspect(workDir, "L92");
    expect(first.staleWarning).toBeUndefined();

    // Mutate the model so its content hash changes.
    const loopFile = join(workDir, ".codeontic", "model", "loops", "extra.yaml");
    const original = await readFile(loopFile, "utf8");
    await writeFile(loopFile, `${original}\n# staleness probe\n`, "utf8");

    // Second run must detect the prior file is stale and say so.
    const second = await runInspect(workDir, "L92");
    expect(second.staleWarning).toBeDefined();
    expect(second.staleWarning).toMatch(
      /was stale: model_content_hash .+ != current .+ regenerated/,
    );
  });

  it("rejects a negative --depth", async () => {
    await expect(runInspect(workDir, "C2", { depth: -1 })).rejects.toThrow(/non-negative integer/);
  });
});

describe("run() — `codeontic inspect` CLI dispatch", () => {
  const io = () => {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      io: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
      lines,
      errors,
    };
  };

  it("inspect <id> [dir] returns 0 and logs the summary + output path", async () => {
    const { io: cio, lines } = io();
    const code = await run(["inspect", "C2", workDir], cio);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("inspect C2 (flow)");
    expect(lines.join("\n")).toContain("wrote");
  });

  it("inspect with no <node-id> returns 1", async () => {
    const { io: cio, errors } = io();
    const code = await run(["inspect"], cio);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("missing <node-id>");
  });

  it("inspect unknown id returns 1", async () => {
    const { io: cio, errors } = io();
    const code = await run(["inspect", "NOPE", workDir], cio);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain('unknown node id "NOPE"');
  });

  it("inspect --depth with a non-integer value returns 1", async () => {
    const { io: cio, errors } = io();
    const code = await run(["inspect", "C2", workDir, "--depth", "abc"], cio);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/--depth must be a non-negative integer/);
  });
});

describe("sliceModel / summarizeSlice — reusable module unit tests", () => {
  it("BFS records each node at its shortest depth and never exceeds maxDepth", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const slice = sliceModel(graph, "C2", 2);
    expect(slice).toBeDefined();
    if (!slice) return;
    expect(slice.nodes.find((n) => n.id === "C2")?.depth).toBe(0);
    for (const n of slice.nodes) expect(n.depth).toBeLessThanOrEqual(2);
    // frontier pointers are strictly outside the visited set
    const ids = new Set(slice.nodes.map((n) => n.id));
    for (const p of slice.frontierPointers) expect(ids.has(p.id)).toBe(false);
  });

  it("records a node reachable by two paths at its SHORTEST depth", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const slice = sliceModel(graph, "C2", 2);
    // L92 is reachable at depth 1 (C2.traverses includes L92) AND at depth 2
    // (C2.crosses J-synth-second, whose `between` includes L92). BFS must
    // record the shortest: depth 1.
    expect(slice?.nodes.find((n) => n.id === "L92")?.depth).toBe(1);
    // ...and mark-at-enqueue means each node is processed exactly once — no
    // duplicate entries even for heavily cross-referenced nodes like L92.
    const seen = slice?.nodes.map((n) => n.id) ?? [];
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns undefined for an unknown root id", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    expect(sliceModel(graph, "NOPE", 2)).toBeUndefined();
  });

  it("annotates loop nodes with effective constraints computed at query time", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const slice = sliceModel(graph, "L91", 1);
    const l91 = slice?.nodes.find((n) => n.id === "L91");
    expect(l91?.effectiveConstraints).toContain("GWT-INV-002");
    // L92's owner does not match the owner_match pattern — no constraint pulled in.
    const l92 = sliceModel(graph, "L92", 0)?.nodes.find((n) => n.id === "L92");
    expect(l92?.effectiveConstraints).toEqual([]);
  });

  it("summary keeps node skeletons and points at the side-channel file for detail", async () => {
    const { graph } = await loadModel(join(workDir, ".codeontic", "model"));
    const slice = sliceModel(graph, "J-synth-second", 1);
    expect(slice).toBeDefined();
    if (!slice) return;
    const summary = summarizeSlice(slice, "/tmp/x.md");
    expect(summary).toContain("J-synth-second");
    expect(summary).toContain("evidence:3 scenarios:2");
    expect(summary).toContain("detail truncated — full slice written to /tmp/x.md");
  });
});
