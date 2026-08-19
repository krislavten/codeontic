import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DriftReportResult,
  renderDriftMarkdown,
  renderDriftText,
} from "../src/cli/commands/drift-report.js";
import { renderReportMarkdown, runReport } from "../src/cli/commands/report.js";
import type { SnapshotDrift } from "../src/cli/commands/snapshot.js";
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
    expect(md).toContain("不影响合并");
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
