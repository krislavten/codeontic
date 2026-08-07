import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConformance } from "../src/cli/commands/conformance.js";
import { loadModel } from "../src/loader/load-model.js";
import { runT0 } from "../src/validate/t0.js";

/**
 * Proposal 016 T6 / D2 — `verified_by` accepts a TEXT anchor.
 *
 * The defect this closes is a trap, not an inconvenience: a JS test's identity
 * is a string with spaces, the `path#symbol` form's symbol segment is `[\w.]+`,
 * so an author who wants to name a real test underscores its title into a
 * symbol that appears nowhere in the file. Combined with the P0 above, the more
 * conscientiously someone filled in `verified_by`, the more phantom `met` they
 * earned. These tests run the whole path (YAML → loader → check → conformance)
 * because the defect only exists end to end.
 */
describe("verified_by text anchors, end to end", () => {
  let dir: string;

  async function write(rel: string, content: string): Promise<void> {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  /** A repo whose one test is named the way real JS tests are named. */
  async function seed(
    verifiedBy: string,
    testTitle = "widget runs and returns one",
  ): Promise<void> {
    await write("src/x.ts", "export class Widget {\n  run() { return 1; }\n}\n");
    await write("test/x.spec.ts", `import { it } from "vitest";\nit('${testTitle}', () => {});\n`);
    await write(
      ".codeontic/model/loops/L1.yaml",
      [
        "- id: L1",
        "  kind: loop",
        "  title: Widget loop",
        '  boundary: "idle -> running -> done"',
        "  owner: src",
        '  anchors: ["src/x.ts#Widget"]',
        "  scenarios: [GWT-L1-001]",
        "",
      ].join("\n"),
    );
    await write(
      ".codeontic/model/scenarios/s.yaml",
      [
        "- id: GWT-L1-001",
        "  kind: scenario",
        "  given: a widget",
        "  when: it runs",
        "  then: it returns one",
        "  level: unit",
        "  verified_by:",
        verifiedBy,
        "",
      ].join("\n"),
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codeontic-verified-by-text-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a {file, text} entry out of verified_by into verified_by_text", async () => {
    await seed('    - {file: test/x.spec.ts, text: "widget runs and returns one"}');
    const { graph, parseErrors } = await loadModel(join(dir, ".codeontic", "model"));
    expect(parseErrors).toEqual([]);
    const scenario = graph.byKind.scenario.get("GWT-L1-001");
    expect(scenario?.verified_by).toEqual([]);
    expect(scenario?.verified_by_text).toEqual([
      { file: "test/x.spec.ts", text: "widget runs and returns one" },
    ]);
  });

  it("keeps both forms when one list mixes them", async () => {
    await seed(
      [
        "    - test/x.spec.ts#Widget",
        '    - {file: test/x.spec.ts, text: "widget runs and returns one"}',
      ].join("\n"),
    );
    const { graph } = await loadModel(join(dir, ".codeontic", "model"));
    const scenario = graph.byKind.scenario.get("GWT-L1-001");
    expect(scenario?.verified_by).toEqual(["test/x.spec.ts#Widget"]);
    expect(scenario?.verified_by_text).toHaveLength(1);
  });

  it("still rejects a malformed object entry, reporting it against the normalized field", async () => {
    // The author wrote the entry inside `verified_by`, so the message names a
    // field they did not type. Tolerated rather than remapped: the value is
    // quoted verbatim in the error, which is what makes it findable, and a
    // remap would put the loader in the business of rewriting zod's messages.
    await seed("    - {file: test/x.spec.ts}"); // no `text`
    const { parseErrors } = await loadModel(join(dir, ".codeontic", "model"));
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]?.message).toContain("verified_by_text");
  });

  it("passes check with ZERO warnings when the title still matches (the whole point)", async () => {
    await seed('    - {file: test/x.spec.ts, text: "widget runs and returns one"}');
    const load = await loadModel(join(dir, ".codeontic", "model"));
    const t0 = await runT0(load, { repoRoot: dir, strictAnchorExistence: true });
    expect(t0.violations).toEqual([]);
    expect(t0.ok).toBe(true);
  });

  it("counts toward conformance's test axis, carrying the scenario's level", async () => {
    await seed('    - {file: test/x.spec.ts, text: "widget runs and returns one"}');
    const result = await runConformance(dir, { repoRoot: dir });
    if (!result.ran) throw new Error(`conformance skipped: ${result.skippedReason}`);
    expect(result.conformance.counts).toEqual({ met: 1, partial: 0, gap: 0 });
    expect(result.conformance.nodes[0]).toMatchObject({ test: "present", testLevels: ["unit"] });
  });

  it("warns (never errors, even under --strict-anchors) once the test is renamed", async () => {
    await seed(
      '    - {file: test/x.spec.ts, text: "widget runs and returns one"}',
      "widget runs and returns TWO",
    );
    const load = await loadModel(join(dir, ".codeontic", "model"));
    const t0 = await runT0(load, { repoRoot: dir, strictAnchorExistence: true });

    // Lenient gate: text matching's false-negative rate on a legitimate reword
    // must not turn a rename into a red build.
    expect(t0.ok).toBe(true);
    expect(t0.violations).toEqual([
      expect.objectContaining({
        check: "anchor-crux",
        severity: "warning",
        nodeId: "GWT-L1-001",
      }),
    ]);
  });

  it("but DOES stop counting on the report card once the test is renamed", async () => {
    await seed(
      '    - {file: test/x.spec.ts, text: "widget runs and returns one"}',
      "widget runs and returns TWO",
    );
    const result = await runConformance(dir, { repoRoot: dir });
    if (!result.ran) throw new Error("should have run");
    expect(result.conformance.counts).toEqual({ met: 0, partial: 1, gap: 0 });
    expect(result.conformance.gaps).toEqual([
      expect.objectContaining({
        kind: "test-stale",
        detail: expect.stringContaining('test/x.spec.ts :: "widget runs and returns one"'),
      }),
    ]);
  });

  it("a MISSING FILE still fails --strict-anchors — the gate cannot be weakened by notation", async () => {
    // The permanent-warning promise covers TEXT MATCHING, not file existence.
    // A missing path is a hard fact in either anchor form, so rewriting an
    // entry from `path#symbol` to `{file, text}` must not excuse it.
    await seed('    - {file: test/nowhere.spec.ts, text: "widget runs and returns one"}');
    const load = await loadModel(join(dir, ".codeontic", "model"));

    const lenient = await runT0(load, { repoRoot: dir });
    expect(lenient.ok).toBe(true);
    expect(lenient.violations).toEqual([
      expect.objectContaining({ check: "anchor-existence", severity: "warning" }),
    ]);

    const strict = await runT0(load, { repoRoot: dir, strictAnchorExistence: true });
    expect(strict.ok).toBe(false);
    expect(strict.violations).toEqual([
      expect.objectContaining({ check: "anchor-existence", severity: "error" }),
    ]);
  });

  it("reports a text anchor whose FILE is gone as a missing test, not a stale one", async () => {
    await seed('    - {file: test/nowhere.spec.ts, text: "widget runs and returns one"}');
    const result = await runConformance(dir, { repoRoot: dir });
    if (!result.ran) throw new Error("should have run");
    expect(result.conformance.gaps).toEqual([expect.objectContaining({ kind: "test-missing" })]);
  });
});
