import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DriftReportResult,
  baseRepoRootIn,
  renderDriftMarkdown,
  renderDriftText,
  scanPrefixOf,
} from "../src/cli/commands/drift-report.js";
import { renderReportMarkdown, runReport } from "../src/cli/commands/report.js";
import { type SnapshotDrift, runSnapshot } from "../src/cli/commands/snapshot.js";
import { run } from "../src/cli/run.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-report-test-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runReport", () => {
  it("runs all three readings through the real dispatcher and keeps their order", async () => {
    await seedSyntheticModel(workDir);
    const result = await runReport(workDir, {}, (args, io) => run(args, io));

    expect(result.sections).toHaveLength(3);
    expect(result.sections[0]?.title).toContain("实现事实对账");
    expect(result.sections[1]?.title).toContain("模型侧覆盖");
    expect(result.sections[2]?.title).toContain("达标判定");
    // The coverage section really ran (it needs no adapter, so it always has output).
    expect(result.sections[1]?.lines.join("\n")).toContain("loop");
  });

  it("markdown carries the caveat that makes coverage and conformance readable together", async () => {
    await seedSyntheticModel(workDir);
    const result = await runReport(workDir, {}, (args, io) => run(args, io));
    const md = renderReportMarkdown(result);

    expect(md).toContain("codeontic 报告档");
    // The specific trap: coverage's scenario✓ does not mean a test backs it.
    expect(md).toContain("verified_by");
    // The readings do not gate merges; the wording no longer says a flat
    // "不影响合并", because --strict-adapter can make this step exit 1.
    expect(md).toContain("不参与合并判定");
    expect(md).toContain("--strict-adapter");
  });

  it("a skipped section marks the report degraded — blank is not 'passed'", async () => {
    await seedSyntheticModel(workDir);
    // No adapter anywhere → reconcile reports a skip.
    const result = await runReport(workDir, { repoRoot: workDir }, (args, io) => run(args, io));
    if (result.degraded) {
      expect(renderReportMarkdown(result)).toContain("管线故障");
    } else {
      // If this environment does resolve an adapter, the section must at least exist.
      expect(result.sections[0]?.lines.length).toBeGreaterThan(0);
    }
  });

  it("without --repo-root the code-scanning section says so — it does not paste the CLI usage", async () => {
    // `reconcile` without --repo-root prints the whole USAGE block to stderr and
    // exits 1; collected as section output that is ~40 lines of help text sitting
    // in a code block, indistinguishable from a reading.
    await seedSyntheticModel(workDir);
    const result = await runReport(workDir, {}, (args, io) => run(args, io));
    const first = result.sections[0]?.lines.join("\n") ?? "";

    expect(first).not.toContain("codeontic reconcile");
    expect(first).toContain("--repo-root");
    expect(first).toContain("这次没查");
    expect(result.degraded).toBe(true);
  });

  it("--no-cache reaches every section, not just the first", async () => {
    // Passing it to reconcile alone produced a report with one freshly-scanned
    // section and one served from a stale cache, with `degraded` still false.
    await seedSyntheticModel(workDir);
    const seen: string[][] = [];
    await runReport(workDir, { repoRoot: workDir, noCache: true }, async (args, io) => {
      seen.push(args);
      return run(args, io);
    });
    const ran = seen.filter((a) => a[0] !== "coverage");
    expect(ran.length).toBeGreaterThan(0);
    for (const args of ran) expect(args).toContain("--no-cache");
  });

  it("report never fails the caller (advisory by construction)", async () => {
    await seedSyntheticModel(workDir);
    const logs: string[] = [];
    const code = await run(["report", workDir], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
    });
    expect(code).toBe(0);
  });
});

describe("report and --strict-adapter", () => {
  it("defaults to advisory: no adapter, exit 0", async () => {
    await seedSyntheticModel(workDir);
    const logs: string[] = [];
    const code = await run(["report", workDir, "--repo-root", workDir], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
    });
    expect(code).toBe(0);
  });

  it("--strict-adapter does not turn unrelated section failures into exit 1", async () => {
    // The first version derived "strict halt" from any section's exit code, so
    // a malformed model YAML (conformance throwing) flipped the exit code only
    // when this flag was present — a flag about adapters changing the outcome
    // of a run with no adapter problem.
    await seedSyntheticModel(workDir);
    // A real (minimal) adapter, so the adapter gate is satisfied either way and
    // the only problem left is the model.
    const adapterPath = join(workDir, "tiny-adapter.mjs");
    await writeFile(
      adapterPath,
      "export default {\n" +
        '  interfaceVersion: "v2",\n' +
        '  name: "tiny",\n' +
        '  version: "1",\n' +
        '  candidatePattern: "nothing-matches-this",\n' +
        "  extractFacts: () => [],\n" +
        "};\n",
    );
    await writeFile(join(workDir, ".codeontic", "model", "loops", "bad.yaml"), "id: [oops\n");
    const logs: string[] = [];
    const args = ["report", workDir, "--repo-root", workDir, "--adapter-path", adapterPath];
    const withoutFlag = await run(args, { log: (l) => logs.push(l), error: (l) => logs.push(l) });
    const withFlag = await run([...args, "--strict-adapter"], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
    });
    // Whatever the answer is, an adapter flag must not be what decides it.
    expect(withFlag).toBe(withoutFlag);
  });

  it("--strict-adapter really fails — the same defect its sibling command just fixed", async () => {
    // drift-report was fixed one commit earlier; `report` had it too, and the
    // banner it prints ("pass --strict-adapter to fail CI on this") was equally
    // untrue here.
    await seedSyntheticModel(workDir);
    const logs: string[] = [];
    const code = await run(["report", workDir, "--repo-root", workDir, "--strict-adapter"], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
    });
    expect(code).toBe(1);
  });
});

describe("drift-report and --strict-adapter", () => {
  it("defaults to advisory: a missing adapter is stated, exit stays 0", async () => {
    await seedSyntheticModel(workDir);
    const logs: string[] = [];
    const code = await run(["drift-report", workDir, "--repo-root", workDir, "--base", "HEAD"], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
    });
    expect(code).toBe(0);
  });

  it("a broken --adapter-path fails even WITHOUT --strict-adapter", async () => {
    // The advisory contract exists so a missing capability does not redden a
    // build. A typo in the adapter path is not a missing capability, and
    // swallowing it means the run reports nothing while looking like it found
    // nothing to report.
    await seedSyntheticModel(workDir);
    const logs: string[] = [];
    const code = await run(
      [
        "drift-report",
        workDir,
        "--repo-root",
        workDir,
        "--base",
        "HEAD",
        "--adapter-path",
        join(workDir, "does-not-exist.js"),
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(l) },
    );
    expect(code).toBe(1);
  });

  it("--strict-adapter really fails — it used to print 'hard failure' and exit 0", async () => {
    // The banner even advises passing this flag "to fail CI on this". Swallowing
    // its halt made that advice permanently false on this one command.
    await seedSyntheticModel(workDir);
    const logs: string[] = [];
    const code = await run(
      ["drift-report", workDir, "--repo-root", workDir, "--base", "HEAD", "--strict-adapter"],
      { log: (l) => logs.push(l), error: (l) => logs.push(l) },
    );
    expect(code).toBe(1);
  });
});

describe("no adapter is 'never ran', not 'found nothing'", () => {
  it("a snapshot without an adapter marks its edge set unavailable, with a cause", async () => {
    await seedSyntheticModel(workDir);
    const snap = await runSnapshot(workDir, { repoRoot: workDir, cacheDir: null });
    // `[]` would be indistinguishable from "scanned, found none" — which is how
    // a repo with no adapter got "no service-call edges were added or removed"
    // on every single PR.
    expect(snap.topologyEdgesUnavailable).toBeTruthy();
    expect(snap.topologyEdgesUnavailable).toContain("adapter");
  });

  it("no repoRoot is reported as its own, more root, cause", async () => {
    await seedSyntheticModel(workDir);
    const snap = await runSnapshot(workDir, { cacheDir: null });
    expect(snap.topologyEdgesUnavailable).toContain("--repo-root");
  });
});

describe("base-side scan scope", () => {
  it("a subdirectory --repo-root scans the SAME subdirectory in the base worktree", async () => {
    // Before this, the base side scanned the whole worktree while HEAD scanned
    // one service — so every other service's edges were reported as "removed by
    // this change" on a PR that touched no edge at all.
    const sub = join(workDir, "services", "api");
    await mkdir(sub, { recursive: true });
    const prefix = await scanPrefixOf(workDir, sub);
    expect(prefix).toBe(join("services", "api"));
    expect(baseRepoRootIn("/tmp/base", prefix)).toBe(join("/tmp/base", "services", "api"));
  });

  it("repoRoot === gitRoot scans the worktree root (no spurious nesting)", async () => {
    const prefix = await scanPrefixOf(workDir, workDir);
    expect(prefix).toBe("");
    expect(baseRepoRootIn("/tmp/base", prefix)).toBe("/tmp/base");
  });

  it("a repoRoot outside the checkout falls back to the root, never to ../ escapes", async () => {
    // realpath differences (macOS /var → /private/var) used to produce a
    // `../../..`-shaped prefix that pointed outside the worktree entirely.
    const outside = await mkdtemp(join(tmpdir(), "codeontic-outside-"));
    try {
      const prefix = await scanPrefixOf(workDir, outside);
      expect(prefix).toBe("");
      expect(baseRepoRootIn("/tmp/base", prefix)).toBe("/tmp/base");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

/** A drift with only the edge fields this renderer reads populated. */
function driftWith(
  addedEdges: { from: string; to: string; toKind?: string }[],
  removedEdges: { from: string; to: string }[],
): SnapshotDrift {
  return {
    adapterBumped: false,
    addedFacts: [],
    removedFacts: [],
    changedFacts: [],
    addedEdges,
    removedEdges,
  } as unknown as SnapshotDrift;
}

describe("renderDrift", () => {
  it("a failed comparison says 'not compared', never 'no new edges'", () => {
    const result: DriftReportResult = { ran: false, reason: "no merge-base" };
    const md = renderDriftMarkdown(result);
    expect(md).toContain("这次没能比较");
    expect(md).toContain("这不等于「没有新增边」");
    expect(renderDriftText(result)).toContain("NOT");
  });

  it("attributes added edges to the change only when both sides had edges", () => {
    const withEdges: DriftReportResult = {
      ran: true,
      topologyEmpty: false,
      drift: driftWith([{ from: "web", to: "api" }], []),
    };
    expect(renderDriftMarkdown(withEdges)).toContain("本次改动新增了 1 条");

    const emptySide: DriftReportResult = { ...withEdges, topologyEmpty: true };
    const md = renderDriftMarkdown(emptySide);
    expect(md).toContain("有一侧的边集合是空的");
    expect(md).toContain("成因待判读");
    expect(md).not.toContain("本次改动新增了 1 条");
  });

  it("no changes reads as 'none' only when attribution is sound", () => {
    const clean: DriftReportResult = {
      ran: true,
      topologyEmpty: false,
      drift: driftWith([], []),
    };
    expect(renderDriftMarkdown(clean)).toContain("没有新增或移除");
    expect(renderDriftMarkdown({ ...clean, topologyEmpty: true })).toContain("不能归因");
  });
});
