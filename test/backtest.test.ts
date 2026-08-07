import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKTEST_SCAN_CAP,
  DEFAULT_BACKTEST_WINDOW,
  collectBacktestCommits,
  parseLogOutput,
  runBacktest,
} from "../src/cli/commands/backtest.js";
import { run } from "../src/cli/run.js";
import { buildGraph } from "../src/loader/model-graph.js";
import {
  computeBacktest,
  computeCoverageRatio,
  formatBacktest,
  formatCoverageRatio,
  pct,
} from "../src/query/backtest.js";
import { coveredFiles } from "../src/validate/unregistered.js";

/**
 * 判据 A (issue #23 阶段1 PR1). Two layers, tested separately:
 *  - `computeBacktest` (pure): given a graph + an already-collected commit
 *    list, does hit-detection and partitioning come out right?
 *  - `collectBacktestCommits`/`runBacktest` (git-backed): does the window
 *    collection over REAL git history behave — post-filter, cap honesty,
 *    ref resolution?
 * plus CLI (`run(["backtest", ...])`) and end-to-end synthetic-repo coverage
 * per the PR1 brief.
 */

// ---------------------------------------------------------------------------
// computeBacktest — pure
// ---------------------------------------------------------------------------

/** All-zero 判据 C information half — spread over with the fields a case cares about. */
const ZERO_INFO = {
  activeLoops: 0,
  loopsWithScenario: 0,
  loopsWithBoundary: 0,
  loopsWithMechanism: 0,
  junctionsWithScenario: 0,
};

describe("computeBacktest — pure hit detection", () => {
  it("locks the covered-file set to coveredFiles(graph) — Loop+Flow anchors, Junction evidence, active AND dormant — never a facts/reconcile-derived set", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: {
          id: "L1",
          kind: "loop",
          title: "active loop",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["src/active.ts#Fn"],
          consumes_queues: [],
          scenarios: [],
        },
      },
      {
        file: "b",
        node: {
          id: "N1",
          kind: "loop",
          title: "dormant loop",
          boundary: "b",
          owner: null,
          dormant: true,
          status: "unverified",
          anchors: ["src/dormant.ts#Fn"],
          consumes_queues: [],
          scenarios: [],
        },
      },
      {
        file: "c",
        node: {
          id: "C1",
          kind: "flow",
          title: "a flow",
          traverses: ["L1"],
          guarded_by: [],
          crosses: [],
          references: [],
          anchors: ["src/flow.ts#Fn"],
          scenarios: [],
          status: "unverified",
        },
      },
      {
        file: "d",
        node: {
          id: "J1",
          kind: "junction",
          risk_class: "handoff",
          between: ["L1", "N1"],
          scenarios: [],
          status: "unverified",
          evidence: [{ id: "e", kind: "code", anchor: "src/junction.ts#Fn" }],
        },
      },
    ]);

    const expected = coveredFiles(graph);
    expect(expected).toEqual(
      new Set(["src/active.ts", "src/dormant.ts", "src/flow.ts", "src/junction.ts"]),
    );

    // Every file coveredFiles(graph) names must register as a hit — including
    // the DORMANT loop's file, which a naive "active-only" implementation
    // would miss.
    for (const f of expected) {
      const { overall } = computeBacktest(graph, [{ sha: "x", tsFiles: [f] }]);
      expect(overall.hit, `${f} should be a hit — it's in coveredFiles(graph)`).toBe(1);
    }
    // A file NOT in that set is a miss, and anchoredFileCount matches the set's size exactly.
    const miss = computeBacktest(graph, [{ sha: "y", tsFiles: ["src/uncovered.ts"] }]);
    expect(miss.overall.hit).toBe(0);
    expect(miss.anchoredFileCount).toBe(expected.size);
  });

  it("a commit hits if ANY of its changed files is covered (file-level, not all-or-nothing)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["src/covered.ts#Fn"],
          consumes_queues: [],
          scenarios: [],
        },
      },
    ]);
    const { overall } = computeBacktest(graph, [
      { sha: "c1", tsFiles: ["src/covered.ts", "src/other.ts"] },
      { sha: "c2", tsFiles: ["src/other.ts"] },
    ]);
    expect(overall).toEqual({ hit: 1, total: 2 });
  });

  const WEB_WORKER_GRAPH = () =>
    buildGraph([
      {
        file: "a",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["apps/web/covered.ts#Fn"],
          consumes_queues: [],
          scenarios: [],
        },
      },
    ]).graph;

  const resolveWebWorker = (f: string) => {
    if (f.startsWith("apps/web/")) return { id: "web", label: "Web", role: "frontend" };
    if (f.startsWith("apps/worker/")) return { id: "worker", label: "Worker", role: "backend" };
    return undefined;
  };

  it("byComponent: a commit can count toward more than one component (and once per component, not once per matching file), and declared-but-untouched components still appear at 0/0", () => {
    const graph = WEB_WORKER_GRAPH();
    const partitioning = {
      declared: [
        { id: "web", label: "Web", role: "frontend" },
        { id: "worker", label: "Worker", role: "backend" },
      ],
      resolve: resolveWebWorker,
    };
    const { overall, byComponent } = computeBacktest(
      graph,
      [
        // touches BOTH web and worker paths, AND two DIFFERENT files within
        // web itself — must count toward web/worker ONCE EACH, not once per
        // matching file (a per-file, non-deduped implementation would report
        // web.total=3 here instead of 2 across the two commits).
        { sha: "c1", tsFiles: ["apps/web/covered.ts", "apps/web/second.ts", "apps/worker/x.ts"] },
        { sha: "c2", tsFiles: ["apps/web/other.ts"] },
      ],
      partitioning,
    );
    expect(overall).toEqual({ hit: 1, total: 2 });
    expect(byComponent).toEqual([
      { id: "web", label: "Web", hit: 1, total: 2 },
      { id: "worker", label: "Worker", hit: 1, total: 1 },
    ]);
  });

  it("byRole: two DIFFERENT components sharing a role dedupe to ONE role-level count per commit, not one per component", () => {
    const graph = WEB_WORKER_GRAPH();
    const partitioning = {
      declared: [
        { id: "web", label: "Web", role: "frontend" },
        { id: "hub", label: "Hub", role: "frontend" }, // same role as web
        { id: "worker", label: "Worker", role: "backend" },
      ],
      resolve: (f: string) => {
        if (f.startsWith("apps/web/")) return { id: "web", label: "Web", role: "frontend" };
        if (f.startsWith("apps/hub/")) return { id: "hub", label: "Hub", role: "frontend" };
        if (f.startsWith("apps/worker/")) return { id: "worker", label: "Worker", role: "backend" };
        return undefined;
      },
    };
    const { byRole } = computeBacktest(
      graph,
      [
        // touches BOTH web and hub (both role=frontend) in the SAME
        // commit — frontend must count this commit ONCE, not twice.
        { sha: "c1", tsFiles: ["apps/web/covered.ts", "apps/hub/x.ts"] },
        { sha: "c2", tsFiles: ["apps/worker/y.ts"] },
      ],
      partitioning,
    );
    expect(byRole).toEqual([
      { id: "frontend", label: "frontend", hit: 1, total: 1 }, // c1 only, deduped
      { id: "backend", label: "backend", hit: 0, total: 1 }, // c2 only
    ]);
  });

  it("adding partitioning NEVER changes `overall` — partitioning is a pure read of the same commit set (locks the team's 'overall 不许变' acceptance criterion)", () => {
    const graph = WEB_WORKER_GRAPH();
    const commits = [
      { sha: "c1", tsFiles: ["apps/web/covered.ts", "apps/worker/x.ts"] },
      { sha: "c2", tsFiles: ["apps/web/other.ts"] },
      { sha: "c3", tsFiles: ["unrelated/file.ts"] },
    ];
    const withoutPartitioning = computeBacktest(graph, commits);
    const withPartitioning = computeBacktest(graph, commits, {
      declared: [
        { id: "web", label: "Web", role: "frontend" },
        { id: "worker", label: "Worker", role: "backend" },
      ],
      resolve: resolveWebWorker,
    });
    expect(withPartitioning.overall).toEqual(withoutPartitioning.overall);
    expect(withPartitioning.anchoredFileCount).toBe(withoutPartitioning.anchoredFileCount);
  });

  it("with no partitioning supplied, byComponent and byRole are both empty (overall-only mode)", () => {
    const { graph } = buildGraph([]);
    const { byComponent, byRole } = computeBacktest(graph, []);
    expect(byComponent).toEqual([]);
    expect(byRole).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeCoverageRatio — pure 判据 C
// ---------------------------------------------------------------------------

describe("computeCoverageRatio — 判据 C (node/covered-file ratio)", () => {
  it("counts loop/flow/junction by graph node (Map size), not by grep-ing `id:` occurrences — a junction's nested evidence ids don't inflate the junction count", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["a.ts#Fn"],
          consumes_queues: [],
          scenarios: [],
        },
      },
      {
        file: "b",
        node: {
          id: "N1",
          kind: "loop",
          title: "dormant",
          boundary: "b",
          owner: null,
          dormant: true,
          status: "unverified",
          anchors: ["b.ts#Fn"],
          consumes_queues: [],
          scenarios: [],
        },
      },
      {
        file: "c",
        node: {
          id: "C1",
          kind: "flow",
          title: "flow",
          traverses: ["L1"],
          guarded_by: [],
          crosses: [],
          references: [],
          anchors: [],
          scenarios: [],
          status: "unverified",
        },
      },
      {
        file: "d",
        node: {
          id: "J1",
          kind: "junction",
          risk_class: "handoff",
          between: ["L1", "N1"],
          scenarios: [],
          status: "unverified",
          // THREE evidence entries, each carrying its own `id:` — a naive
          // text-scan of `id:` occurrences would count 3 junctions here (plus
          // the loops'/flow's own ids). The graph-node count must stay 1.
          evidence: [
            { id: "e1", kind: "code", anchor: "a.ts#Fn" },
            { id: "e2", kind: "code", anchor: "e2.ts#Fn" },
            { id: "e3", kind: "spec", anchor: "docs/spec.md#s" },
          ],
        },
      },
    ]);
    const stats = computeCoverageRatio(graph);
    expect(stats.nodes).toEqual({
      loop: 2,
      loopDormant: 1,
      flow: 1,
      junction: 1,
      total: 4,
      // L1 (anchored), N1 (dormant BUT anchored — its anchor really does
      // register a file, so excluding it would understate the numerator
      // against a denominator that includes that file), J1 (has evidence).
      // The flow here carries no anchors, so it is declared but not anchored.
      anchored: 3,
    });
    // Hardcoded, NOT derived from `coveredFiles(graph)` — comparing against
    // that helper's own output would be circular (computeCoverageRatio calls
    // it internally too, so a shared bug in both would still pass). Hand
    // counted from the fixture above: a.ts (L1 anchor + J1 evidence, same
    // file — counts once), b.ts (N1, dormant), e2.ts (J1 evidence), and
    // docs/spec.md (J1's third evidence entry — junction evidence anchors
    // are NOT filtered by extension, see coveredFiles' doc) = 4 distinct files.
    expect(stats.coveredFileCount).toBe(4);
    // 3 ANCHORED nodes ÷ 4 covered files. The all-node figure (4/4 = 1) is
    // reported separately for context — it is not the guard, because a node
    // with no anchor touches no file and so cannot be compressing anything.
    expect(stats.ratio).toBe(3 / 4);
    expect(stats.ratioAllNodes).toBe(1);
  });

  it("ratio is null (not Infinity, not a fake 0) when there are zero covered files", () => {
    const { graph } = buildGraph([]);
    const stats = computeCoverageRatio(graph);
    expect(stats.nodes.total).toBe(0);
    expect(stats.coveredFileCount).toBe(0);
    expect(stats.ratio).toBeNull();
  });

  it("formatCoverageRatio prints n/a for a null ratio and a fixed 2-decimal number otherwise", () => {
    expect(
      formatCoverageRatio({
        nodes: { loop: 0, loopDormant: 0, flow: 0, junction: 0, total: 0, anchored: 0 },
        information: ZERO_INFO,
        coveredFileCount: 0,
        ratio: null,
        ratioAllNodes: null,
      })[0],
    ).toContain("n/a");
    const lines = formatCoverageRatio({
      nodes: { loop: 67, loopDormant: 12, flow: 9, junction: 6, total: 82, anchored: 34 },
      information: {
        activeLoops: 55,
        loopsWithScenario: 7,
        loopsWithBoundary: 55,
        loopsWithMechanism: 2,
        junctionsWithScenario: 6,
      },
      coveredFileCount: 39,
      ratio: 34 / 39,
      ratioAllNodes: 82 / 39,
    });
    // The headline is the ANCHORED ratio, not the all-node one.
    expect(lines[0]).toContain("34 anchored node(s)");
    expect(lines[0]).toContain("0.87"); // 34/39 rounded to 2dp
    expect(lines[1]).toContain("82");
    expect(lines[1]).toContain("12 dormant");
    expect(lines[1]).toContain("2.10"); // 82/39, context only
    // 判据 C's other half must be printed too — the ratio alone cannot tell
    // healthy anchor-adding from node-stuffing (both move it toward 1:1).
    expect(lines[2]).toContain("7/55");
    expect(lines.join("\n")).toContain("cannot separate healthy growth from gaming");
  });
});

describe("pct", () => {
  it("formats a percentage, and 'n/a' for a zero denominator (never a fake 0%)", () => {
    expect(pct(18, 50)).toBe("36%");
    expect(pct(0, 0)).toBe("n/a");
  });
});

// ---------------------------------------------------------------------------
// parseLogOutput — pure git-log parser
// ---------------------------------------------------------------------------

describe("parseLogOutput", () => {
  it("splits sentinel-delimited git log --name-only output into per-commit file lists", () => {
    const stdout = "\x01aaa111\n\nsrc/a.ts\nsrc/b.ts\n\x01bbb222\n\ndocs/readme.md\n\x01ccc333\n\n";
    const parsed = parseLogOutput(stdout);
    expect(parsed).toEqual([
      { sha: "aaa111", files: ["src/a.ts", "src/b.ts"] },
      { sha: "bbb222", files: ["docs/readme.md"] },
      { sha: "ccc333", files: [] }, // an empty-diff commit (e.g. --allow-empty) has no files
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseLogOutput("")).toEqual([]);
  });

  it("an empty-diff commit sandwiched between two file-carrying commits doesn't swallow or misattribute neighboring files", () => {
    const stdout =
      "\x01c1\n\nsrc/a.ts\n" + // has files
      "\x01c2\n\n" + // empty diff — no files at all
      "\x01c3\n\nsrc/b.ts\nsrc/c.ts\n" + // has files
      "\x01c4\n\n"; // empty diff again, at the very end
    expect(parseLogOutput(stdout)).toEqual([
      { sha: "c1", files: ["src/a.ts"] },
      { sha: "c2", files: [] },
      { sha: "c3", files: ["src/b.ts", "src/c.ts"] },
      { sha: "c4", files: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// collectBacktestCommits / runBacktest — git-backed
// ---------------------------------------------------------------------------

describe("collectBacktestCommits / runBacktest — git-backed", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-backtest-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const commit = async (rel: string, content: string, msg: string) => {
    const dir = rel.split("/").slice(0, -1).join("/") || ".";
    await mkdir(join(repo, dir), { recursive: true });
    await writeFile(join(repo, rel), content);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repo });
  };

  /**
   * Builds a small, hand-verified history:
   *   c0 README.md            (non-ts — excluded from the window)
   *   c1 src/covered.ts       (ts — HIT)
   *   c2 src/other.ts         (ts — miss)
   *   c3 docs/note.md         (non-ts — excluded)
   *   c4 src/covered.ts (mod) (ts — HIT)
   *   c5 src/other.ts (mod)   (ts — miss)
   * Newest-first post-filter order is: c5(miss) c4(hit) c2(miss) c1(hit) —
   * 4 qualifying commits total, 2 hits.
   */
  const seedHistory = async () => {
    await commit("README.md", "hello", "c0 readme");
    await commit("src/covered.ts", "export const a = 1;", "c1 covered");
    await commit("src/other.ts", "export const b = 1;", "c2 other");
    await commit("docs/note.md", "note", "c3 docs");
    await commit("src/covered.ts", "export const a = 2;", "c4 covered mod");
    await commit("src/other.ts", "export const b = 2;", "c5 other mod");
  };

  it("collects only .ts/.tsx-touching commits, most-recent-first, and reports how many raw commits it walked", async () => {
    await seedHistory();
    const collected = await collectBacktestCommits(repo, "HEAD", 4);
    expect(collected).toBeDefined();
    expect(collected?.commits.map((c) => c.tsFiles)).toEqual([
      ["src/other.ts"],
      ["src/covered.ts"],
      ["src/other.ts"],
      ["src/covered.ts"],
    ]);
    // walked c5,c4,c3(skipped, non-ts),c2,c1 = 5 raw commits to collect 4 qualifying ones.
    expect(collected?.commitsScanned).toBe(5);
    expect(collected?.scanCapped).toBe(false);
  });

  it("reports the shortfall honestly (not scanCapped) when history genuinely runs out before the window fills", async () => {
    await seedHistory(); // only 4 qualifying commits exist in the whole history
    const collected = await collectBacktestCommits(repo, "HEAD", 6);
    expect(collected?.commits).toHaveLength(4);
    expect(collected?.scanCapped).toBe(false); // ran out of history, not capped
  });

  it("reports scanCapped=true when the internal scan cap is hit before the window fills", async () => {
    await seedHistory();
    // scanCap=2: only c5,c4 get walked, both qualify, but window(4) isn't full
    // and there IS more history beyond the cap — must say so, not silently
    // report "4 commits total" as if that were the whole truth.
    const collected = await collectBacktestCommits(repo, "HEAD", 4, 2);
    expect(collected?.commits).toHaveLength(2);
    expect(collected?.commitsScanned).toBe(2);
    expect(collected?.scanCapped).toBe(true);
  });

  it("returns undefined for a bad ref (caller reports a clean skip, not a throw)", async () => {
    await commit("a.ts", "x", "c1");
    expect(await collectBacktestCommits(repo, "no-such-ref", 10)).toBeUndefined();
  });

  it("runBacktest end to end: overall hit rate over a real repo + real model anchors", async () => {
    await seedHistory();
    await mkdir(join(repo, ".codeontic", "model", "loops"), { recursive: true });
    await writeFile(
      join(repo, ".codeontic", "model", "loops", "L1.yaml"),
      [
        "id: L1",
        "kind: loop",
        "title: t",
        "boundary: b",
        "owner: o",
        'anchors: ["src/covered.ts#Fn"]',
      ].join("\n"),
    );

    const result = await runBacktest(repo, { repoRoot: repo, window: 4 });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error("unreachable");
    expect(result.report.overall).toEqual({ hit: 2, total: 4 });
    expect(result.report.anchoredFileCount).toBe(1);
    expect(result.report.windowRequested).toBe(4);
    expect(result.report.componentsDeclared).toBe(false);
    expect(result.report.byComponent).toEqual([]);
    expect(result.report.byRole).toEqual([]);
    // 判据 C rides along: one loop, no dormant, no flow/junction, 1 covered file.
    expect(result.coverageRatio).toEqual({
      nodes: { loop: 1, loopDormant: 0, flow: 0, junction: 0, total: 1, anchored: 1 },
      information: { ...ZERO_INFO, activeLoops: 1, loopsWithBoundary: 1 },
      coveredFileCount: 1,
      ratio: 1,
      ratioAllNodes: 1,
    });
    // model ref rides along too — repo has real commits, so head is a real
    // 40-char sha; dirty:true is correct here (the model YAML above was
    // written to disk but never `git add`+committed — exactly the kind of
    // "uncommitted model edit" this field exists to surface).
    expect(result.modelRef.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.modelRef.dirty).toBe(true);

    const lines = formatBacktest(result.report, result.modelRef);
    expect(lines.some((l) => l.includes("overall: 2/4 (50%)"))).toBe(true);
    expect(lines[0]).toContain(`model @ ${result.modelRef.head?.slice(0, 8)}`);
  });

  it("runBacktest skips cleanly (never throws) when repoRoot isn't a git checkout, but 判据 C still survives (model loaded fine, only git failed)", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "codeontic-nongit-"));
    try {
      await mkdir(join(nonGit, ".codeontic", "model", "loops"), { recursive: true });
      await writeFile(
        join(nonGit, ".codeontic", "model", "loops", "L1.yaml"),
        [
          "id: L1",
          "kind: loop",
          "title: t",
          "boundary: b",
          "owner: o",
          'anchors: ["a.ts#Fn"]',
        ].join("\n"),
      );
      const result = await runBacktest(nonGit, { repoRoot: nonGit });
      expect(result.ran).toBe(false);
      if (result.ran) throw new Error("unreachable");
      expect(result.skippedReason).toMatch(/not inside a git checkout/);
      // The git-side failure must NOT also swallow C — it needs only the model,
      // which loaded fine here.
      expect(result.coverageRatio).toEqual({
        nodes: { loop: 1, loopDormant: 0, flow: 0, junction: 0, total: 1, anchored: 1 },
        information: { ...ZERO_INFO, activeLoops: 1, loopsWithBoundary: 1 },
        coveredFileCount: 1,
        ratio: 1,
        ratioAllNodes: 1,
      });
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("判据 C is ABSENT when the model itself never loaded (no coverageRatio to compute)", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "codeontic-noModel-"));
    try {
      // No .codeontic/model dir at all → loadModel throws → the earliest
      // possible `ran: false`, before C is ever computed.
      const result = await runBacktest(emptyDir, { repoRoot: emptyDir });
      expect(result.ran).toBe(false);
      if (result.ran) throw new Error("unreachable");
      expect(result.coverageRatio).toBeUndefined();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("runBacktest defaults repoRoot to targetDir (self-hosted model dir IS the repo)", async () => {
    await commit("src/x.ts", "x", "c1");
    await mkdir(join(repo, ".codeontic", "model"), { recursive: true });
    const result = await runBacktest(repo); // no repoRoot given
    expect(result.ran).toBe(true);
  });

  it("component partitioning (opt-in via .codeontic/config.json `components`)", async () => {
    await mkdir(join(repo, "apps", "web"), { recursive: true });
    await mkdir(join(repo, "apps", "worker"), { recursive: true });
    await writeFile(join(repo, "apps", "web", "a.ts"), "export const a = 1;");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "web change"], { cwd: repo });
    await writeFile(join(repo, "apps", "worker", "b.ts"), "export const b = 1;");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "worker change"], { cwd: repo });

    await mkdir(join(repo, ".codeontic", "model", "loops"), { recursive: true });
    await writeFile(
      join(repo, ".codeontic", "model", "loops", "L1.yaml"),
      [
        "id: L1",
        "kind: loop",
        "title: t",
        "boundary: b",
        "owner: o",
        'anchors: ["apps/web/a.ts#Fn"]',
      ].join("\n"),
    );
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        components: [
          { id: "web", label: "Web", role: "frontend", paths: ["apps/web"] },
          { id: "worker", role: "worker", paths: ["apps/worker"] },
        ],
      }),
    );

    const result = await runBacktest(repo, { repoRoot: repo, window: 10 });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error("unreachable");
    expect(result.report.componentsDeclared).toBe(true);
    expect(result.report.byComponent).toEqual([
      { id: "web", label: "Web", hit: 1, total: 1 },
      { id: "worker", label: "worker", hit: 0, total: 1 }, // no label declared → falls back to id
    ]);
    // "worker" is its own role here (declared role: "worker") — a single
    // component's role, real Component.role values (frontend/api/worker/
    // sandbox/library) are exercised by a target repo's components integration
    // check, not this synthetic repo. This just proves role rows appear.
    expect(result.report.byRole).toEqual([
      { id: "frontend", label: "frontend", hit: 1, total: 1 },
      { id: "worker", label: "worker", hit: 0, total: 1 },
    ]);
  });

  it("a malformed components config is a loud failure, not a silent downgrade to overall-only", async () => {
    await commit("src/x.ts", "x", "c1");
    await mkdir(join(repo, ".codeontic", "model"), { recursive: true });
    await writeFile(join(repo, ".codeontic", "config.json"), "{ not json");

    const result = await runBacktest(repo, { repoRoot: repo });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error("unreachable");
    expect(result.skippedReason).toMatch(/not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// CLI: `codeontic backtest`
// ---------------------------------------------------------------------------

describe("run() — `codeontic backtest` CLI dispatch", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-backtest-cli-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1;");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "c1"], { cwd: repo });
    await mkdir(join(repo, ".codeontic", "model", "loops"), { recursive: true });
    await writeFile(
      join(repo, ".codeontic", "model", "loops", "L1.yaml"),
      [
        "id: L1",
        "kind: loop",
        "title: t",
        "boundary: b",
        "owner: o",
        'anchors: ["src/a.ts#Fn"]',
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const makeIo = () => {
    const logs: string[] = [];
    return {
      io: { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) },
      logs,
    };
  };

  it("reports a human-readable overall hit rate and exits 0", async () => {
    const { io, logs } = makeIo();
    const exitCode = await run(["backtest", repo, "--repo-root", repo, "--window", "5"], io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("overall: 1/1 (100%)"))).toBe(true);
    expect(logs.some((l) => l.includes("no components declared"))).toBe(true);
  });

  it("--json emits a single JSON value: {ran, report, coverageRatio} — not report's fields spread onto the top level", async () => {
    const { io, logs } = makeIo();
    const exitCode = await run(["backtest", repo, "--repo-root", repo, "--json"], io);
    expect(exitCode).toBe(0);
    // Exactly one log call in --json mode — no free-text warning line mixed
    // in, so `logs.join("")` (or `logs[0]` alone) is always valid JSON.
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0] ?? "") as {
      ran: boolean;
      report: { overall: { hit: number; total: number } };
      coverageRatio: { ratio: number | null };
    };
    expect(parsed.ran).toBe(true);
    expect(parsed.report.overall).toEqual({ hit: 1, total: 1 });
    expect(parsed.coverageRatio).toBeDefined();
  });

  it("--window must be a positive integer", async () => {
    const { io, logs } = makeIo();
    const exitCode = await run(["backtest", repo, "--window", "0"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("--window must be a positive integer"))).toBe(true);
  });

  it("--repo-root as the last token (missing value) is a loud CLI-misuse error, not a silent skip", async () => {
    const { io, logs } = makeIo();
    const exitCode = await run(["backtest", repo, "--repo-root"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("--repo-root requires a value"))).toBe(true);
  });

  it("defaults window to DEFAULT_BACKTEST_WINDOW when --window is omitted", async () => {
    const { io, logs } = makeIo();
    await run(["backtest", repo, "--repo-root", repo, "--json"], io);
    const parsed = JSON.parse(logs[0] ?? "") as { report: { windowRequested: number } };
    expect(parsed.report.windowRequested).toBe(DEFAULT_BACKTEST_WINDOW);
  });

  it("--json in the ran:false (skip) case still emits exactly one JSON value, never text + JSON mixed on the same stream", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "codeontic-backtest-jsonskip-"));
    try {
      const { io, logs } = makeIo();
      const exitCode = await run(["backtest", emptyDir, "--repo-root", repo, "--json"], io);
      expect(exitCode).toBe(0);
      expect(logs).toHaveLength(1); // NOT a "⚠ backtest skipped" line followed by a JSON blob
      const parsed = JSON.parse(logs[0] ?? "") as { ran: boolean; skippedReason: string };
      expect(parsed.ran).toBe(false);
      expect(parsed.skippedReason).toBeTruthy();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("skips cleanly (exit 0, ⚠ line) when the model dir doesn't exist", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "codeontic-backtest-noModel-"));
    try {
      const { io, logs } = makeIo();
      const exitCode = await run(["backtest", emptyDir, "--repo-root", repo], io);
      expect(exitCode).toBe(0);
      expect(logs.some((l) => l.includes("⚠ backtest skipped"))).toBe(true);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("BACKTEST_SCAN_CAP is a sane, exported constant (guards against an accidental unbounded walk)", () => {
    expect(BACKTEST_SCAN_CAP).toBeGreaterThan(DEFAULT_BACKTEST_WINDOW);
  });
});
