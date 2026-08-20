import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, ImplementationFact } from "../src/adapters/types.js";
import type { BacktestResult } from "../src/cli/commands/backtest.js";
import {
  type Snapshot,
  buildSnapshot,
  diffSnapshots,
  loadSnapshot,
  renderDrift,
  renderSnapshotSummary,
  runSnapshot,
  writeSnapshot,
} from "../src/cli/commands/snapshot.js";
import { run } from "../src/cli/run.js";
import type { Component } from "../src/config/components.js";
import type { Inv1CheckResult } from "../src/validate/inv1/check.js";
import type { T0Result } from "../src/validate/types.js";
import { computeTopologyModel } from "../src/views/topology-html.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

const T0_OK: T0Result = { ok: true, violations: [] };
const META = {
  adapterVersion: "synthetic-facts-1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  timingMs: 12,
};

/**
 * Synthetic adapter (Proposal 010 — no built-in adapter ships with this
 * engine). `candidatePattern` also names the two topology markers
 * (CALL_DB/CALL_REDIS, § edge-granularity drift tests below) — `git grep`
 * pre-filters on this pattern, so a marker missing from it would never even
 * reach `extractFacts` (see `runFacts`'s gitGrepCandidates).
 */
const syntheticAdapter: Adapter = {
  interfaceVersion: "v2",
  name: "synthetic",
  version: "synthetic-facts-1",
  candidatePattern: "RUN_QUEUE|setInterval|CALL_DB|CALL_REDIS",
  extractFacts(filePath: string, content: string): ImplementationFact[] {
    const facts: ImplementationFact[] = [];
    if (content.includes("run:execute")) {
      facts.push({ signal: "pg_boss_queue", name: "run:execute", filePath, line: 1 });
    }
    if (content.includes("setInterval")) {
      facts.push({ signal: "setinterval_poller", name: `poll@${filePath}`, filePath, line: 2 });
    }
    // Topology-tagged facts (§ edge-granularity drift tests below) — one per
    // call site, exactly the shape (issue #23 阶段2 Q2) that makes a call
    // site's file move look like drift at FACT granularity even though
    // nothing architectural changed.
    if (content.includes("CALL_DB")) {
      facts.push({
        signal: "outbound_edge",
        name: "db",
        filePath,
        line: 3,
        topology: { to: "postgres", toKind: "datastore" },
      });
    }
    if (content.includes("CALL_REDIS")) {
      facts.push({
        signal: "outbound_edge",
        name: "cache",
        filePath,
        line: 4,
        topology: { to: "redis", toKind: "queue" },
      });
    }
    return facts;
  },
};
type RawFact = Parameters<typeof buildSnapshot>[2][number];
const queue = (name: string, filePath: string, line: number, detail?: string): RawFact => ({
  signal: "pg_boss_queue",
  name,
  filePath,
  line,
  ...(detail ? { detail } : {}),
});
const edgeFact = (filePath: string, to: string, toKind: string): RawFact => ({
  signal: "outbound_edge",
  name: to,
  filePath,
  line: 1,
  topology: { to, toKind },
});

/** A synthetic `runBacktest` success result — see test/backtest.test.ts for
 * coverage of runBacktest itself; these snapshot tests only check the WIRING. */
// Typed as the SUCCESS arm, not the `BacktestResult` union: every use below
// reads `.report`, and a union-typed const forces a cast at each of them.
// `satisfies` keeps it assignable to the union where buildSnapshot wants one.
const BACKTEST_RAN = {
  ran: true,
  report: {
    anchoredFileCount: 3,
    overall: { hit: 18, total: 50 },
    byComponent: [],
    byRole: [],
    ref: "HEAD",
    windowRequested: 50,
    commitsScanned: 55,
    scanCapped: false,
    componentsDeclared: false,
  },
  coverageRatio: {
    nodes: { loop: 4, loopDormant: 1, flow: 1, junction: 1, total: 6, anchored: 6 },
    information: {
      activeLoops: 3,
      loopsWithScenario: 1,
      loopsWithBoundary: 3,
      loopsWithMechanism: 0,
      junctionsWithScenario: 1,
    },
    coveredFileCount: 3,
    ratio: 2,
    ratioAllNodes: 2,
  },
  modelRef: { head: "a".repeat(40), dirty: false },
} satisfies BacktestResult;

describe("snapshot / T2 nightly artifact (Proposal 006 D2)", () => {
  it("buildSnapshot drops the unstable `line` from the digest and sorts facts", () => {
    const snap = buildSnapshot(
      META,
      T0_OK,
      [queue("z", "b.ts", 9), queue("a", "a.ts", 3)],
      undefined,
    );
    expect(snap.facts.map((f) => f.name)).toEqual(["a", "z"]); // sorted by identity
    // line must not survive into the digest — a cosmetic shift can't be drift.
    expect(snap.facts[0]).not.toHaveProperty("line");
    expect(snap.factCount).toBe(2);
    expect(snap.adapterVersion).toBe("synthetic-facts-1");
  });

  it("buildSnapshot summarizes T0 and INV-1 counts", () => {
    const t0: T0Result = {
      ok: false,
      violations: [
        { check: "schema", severity: "error", message: "x" },
        { check: "anchor-existence", severity: "warning", message: "y" },
      ],
    };
    const inv1: Inv1CheckResult = {
      ran: true,
      writePoints: [
        {
          filePath: "f.ts",
          line: 1,
          table: "runs",
          columns: ["status"],
          verdict: "violation",
          reason: "",
          snippet: "",
        },
        {
          filePath: "g.ts",
          line: 2,
          table: null,
          columns: "opaque",
          verdict: "unanalyzable",
          reason: "",
          snippet: "",
        },
        {
          filePath: "h.ts",
          line: 3,
          table: "runs",
          columns: ["status"],
          verdict: "allowed",
          reason: "",
          snippet: "",
        },
      ],
      candidateFiles: 3,
      filesScanned: 3,
      timingMs: 5,
    };
    const snap = buildSnapshot(META, t0, [], inv1);
    expect(snap.t0).toEqual({ ok: false, errors: 1, warnings: 1 });
    expect(snap.inv1).toMatchObject({ ran: true, violations: 1, unanalyzable: 1, writePoints: 3 });
  });

  it("buildSnapshot embeds the 判据 A backtest report when supplied, and defaults to a ran:false skip when omitted", () => {
    const withBacktest = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN);
    expect(withBacktest.backtest).toEqual({
      ran: true,
      ref: "HEAD",
      windowRequested: 50,
      commitsScanned: 55,
      scanCapped: false,
      anchoredFileCount: 3,
      overall: { hit: 18, total: 50 },
      byComponent: [],
      byRole: [],
      componentsDeclared: false,
    });

    const withoutBacktest = buildSnapshot(META, T0_OK, [], undefined);
    expect(withoutBacktest.backtest.ran).toBe(false);
    expect(withoutBacktest.backtest.overall).toEqual({ hit: 0, total: 0 });
  });

  /**
   * The summary line must not contradict itself. It once printed
   * `C 82/40=0.85` — the ratio came from the ANCHORED node count while the
   * numerator shown was the TOTAL, so the division a reader performs gives a
   * different answer than the one printed, with no way to tell which half is
   * wrong. A self-inconsistent summary is worse than a missing one.
   *
   * The fixture below deliberately gives `total` and `anchored` DIFFERENT
   * values. With them equal (as they happen to be in BACKTEST_RAN) every
   * assertion here passes no matter which one the formatter reads — the test
   * would be vacuous exactly where it needs to bite.
   */
  it("renderSnapshotSummary's 判据 C fragment agrees with itself: anchored numerator, covered-file denominator", () => {
    const c = {
      ...BACKTEST_RAN.coverageRatio,
      nodes: { ...BACKTEST_RAN.coverageRatio.nodes, total: 9, anchored: 6 },
      coveredFileCount: 3,
      ratio: 2, // 6 anchored / 3 files
      ratioAllNodes: 3, // 9 total / 3 files — the number that must NOT appear
    };
    const line = renderSnapshotSummary(buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN, c));
    // Strict number shape: `[\d.]+` would happily match a malformed "1.2.3"
    // and hand `Number()` a NaN, turning a formatting bug into a confusing
    // assertion failure instead of a clear one.
    const m = line.match(/C (\d+)\/(\d+)=(\d+(?:\.\d+)?)/);
    expect(m, `no C fragment in: ${line}`).toBeTruthy();
    const [, shown, files, printed] = m ?? [];
    // Numerator is the ANCHORED count (6), never the declared total (9).
    expect(Number(shown)).toBe(6);
    // Denominator is the covered-file count, not some other node count.
    expect(Number(files)).toBe(3);
    // Exact, not approximate: the printed ratio IS shown ÷ files. A tolerant
    // comparison would let an off-by-one numerator through.
    expect(Number(printed)).toBe(Number(shown) / Number(files));
    // And the all-node ratio must not be what got printed.
    expect(Number(printed)).not.toBe(c.ratioAllNodes);
  });

  it("renderSnapshotSummary's n/a branch also names the anchored count, not the declared total", () => {
    // ratio === null happens only when there are zero covered files; the
    // fragment then has no division to print, but the count it DOES print
    // must still be the same one the ratio would have used.
    const c = {
      ...BACKTEST_RAN.coverageRatio,
      nodes: { ...BACKTEST_RAN.coverageRatio.nodes, total: 9, anchored: 6 },
      coveredFileCount: 0,
      ratio: null,
      ratioAllNodes: null,
    };
    const line = renderSnapshotSummary(buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN, c));
    expect(line).toContain("C 6 anchored node(s), n/a");
    expect(line).not.toContain("C 9");
  });

  it("renderSnapshotSummary includes the backtest hit rate, or 'backtest skipped' when it didn't run", () => {
    expect(
      renderSnapshotSummary(buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN)),
    ).toContain("backtest 18/50 (36%)");
    expect(renderSnapshotSummary(buildSnapshot(META, T0_OK, [], undefined))).toContain(
      "backtest skipped",
    );
  });

  it("renderSnapshotSummary's judgement C fragment uses the SAME numerator (anchored, not total) the ratio was computed from — the two halves of 'X/Y=Z' must agree", () => {
    // total(10) deliberately != anchored(4) here, so a regression back to
    // printing `nodes.total` (which BACKTEST_RAN's own fixture can't catch —
    // its total and anchored happen to be equal) would show up as "C 10/4=…"
    // instead of the correct "C 4/4=1.00".
    const summary = renderSnapshotSummary(
      buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN, {
        ...BACKTEST_RAN.coverageRatio,
        nodes: { ...BACKTEST_RAN.coverageRatio.nodes, total: 10, anchored: 4 },
        coveredFileCount: 4,
        ratio: 1,
      }),
    );
    expect(summary).toContain("C 4/4=1.00");
  });

  it("backtestDelta is surfaced in drift but does NOT affect `clean` — the trailing window naturally shifts every run", () => {
    const before = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN);
    const after = buildSnapshot(META, T0_OK, [], undefined, {
      ran: true,
      report: { ...BACKTEST_RAN.report, overall: { hit: 20, total: 50 } },
      coverageRatio: BACKTEST_RAN.coverageRatio,
      modelRef: BACKTEST_RAN.modelRef,
    });
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true); // nothing ELSE changed
    expect(drift.backtestDelta).toEqual({
      hitBefore: 18,
      totalBefore: 50,
      hitAfter: 20,
      totalAfter: 50,
    });
    const report = renderDrift(drift);
    expect(report[0]).toContain("backtest: 18/50 (36%) → 20/50 (40%)");
    // still shows "no drift" for the facts/T0/INV-1 axes — the two lines coexist.
    expect(report).toContain("no drift (facts, T0, INV-1, and judgement C all unchanged)");
  });

  it("no backtest line when the hit/total is unchanged between two ran snapshots", () => {
    const before = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN);
    const after = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN);
    const drift = diffSnapshots(before, after);
    expect(drift.backtestDelta).toEqual({
      hitBefore: 18,
      totalBefore: 50,
      hitAfter: 18,
      totalAfter: 50,
    });
    // Exact array, not `.toContain` — the whole point of this case is that
    // an UNCHANGED backtest must add NO line at all; `.toContain` would miss
    // a regression that starts pushing a noise line even when nothing moved.
    // (Precondition for this exact single-line shape: both snapshots share
    // `META.adapterVersion`, so `adapterBumped` is false here and doesn't
    // add its own line first — see the "an adapter bump..." cases below for
    // that line's own coverage.)
    expect(renderDrift(drift)).toEqual([
      "no drift (facts, T0, INV-1, and judgement C all unchanged)",
    ]);
  });

  it("backtestDelta is undefined when only one of the two snapshots ran a backtest", () => {
    const before = buildSnapshot(META, T0_OK, [], undefined); // no repo-root → not run
    const after = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN);
    const drift = diffSnapshots(before, after);
    expect(drift.backtestDelta).toBeUndefined();
  });

  it("判据 C node/covered-file count changes DO make `clean` false — unlike backtestDelta, C is real target drift, not a window artifact", () => {
    // NOTE: `Snapshot.coverageRatio` comes from `buildSnapshot`'s own 6th
    // positional arg (mirroring how `runSnapshot` computes it independently
    // of `backtest`, from `model.graph`, before any git call) — NOT from
    // `BacktestResult.coverageRatio` on the `backtest` (5th) arg. The two are
    // separate on purpose (see Snapshot.coverageRatio's doc: C must survive
    // a git-side failure that makes `backtest.ran` false).
    const before = buildSnapshot(
      META,
      T0_OK,
      [],
      undefined,
      BACKTEST_RAN,
      BACKTEST_RAN.coverageRatio,
    );
    const after = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN, {
      nodes: { loop: 5, loopDormant: 1, flow: 1, junction: 1, total: 7, anchored: 7 }, // +1 node
      information: BACKTEST_RAN.coverageRatio.information,
      coveredFileCount: 3, // unchanged
      ratio: 7 / 3,
      ratioAllNodes: 7 / 3,
    });
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(false);
    expect(drift.coverageRatioDelta).toEqual({
      nodesTotalBefore: 6,
      nodesTotalAfter: 7,
      nodesAnchoredBefore: 6,
      nodesAnchoredAfter: 7,
      coveredFileCountBefore: 3,
      coveredFileCountAfter: 3,
    });
    expect(renderDrift(drift)).toContain("judgement C nodes +1");
    expect(renderDrift(drift)).toContain("judgement C anchored nodes +1");
  });

  it("anchoring an EXISTING node (nodesTotal unchanged, nodesAnchored up) still registers as drift — the healthy move this plan's own next steps make", () => {
    const before = buildSnapshot(
      META,
      T0_OK,
      [],
      undefined,
      BACKTEST_RAN,
      BACKTEST_RAN.coverageRatio,
    );
    const after = buildSnapshot(META, T0_OK, [], undefined, BACKTEST_RAN, {
      ...BACKTEST_RAN.coverageRatio,
      nodes: {
        ...BACKTEST_RAN.coverageRatio.nodes,
        anchored: BACKTEST_RAN.coverageRatio.nodes.anchored + 1,
      },
      coveredFileCount: BACKTEST_RAN.coverageRatio.coveredFileCount + 1,
      ratio:
        (BACKTEST_RAN.coverageRatio.nodes.anchored + 1) /
        (BACKTEST_RAN.coverageRatio.coveredFileCount + 1),
    });
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(false); // nodesTotal is UNCHANGED — only anchored + coveredFileCount moved
    expect(drift.coverageRatioDelta.nodesTotalBefore).toBe(
      drift.coverageRatioDelta.nodesTotalAfter,
    );
    expect(
      drift.coverageRatioDelta.nodesAnchoredAfter - drift.coverageRatioDelta.nodesAnchoredBefore,
    ).toBe(1);
    expect(renderDrift(drift)).toContain("judgement C anchored nodes +1");
    expect(renderDrift(drift).some((l) => l.startsWith("judgement C nodes "))).toBe(false); // nodesTotal didn't move
  });

  it("a LINE-ONLY change is NOT drift (the core stability guarantee)", () => {
    const before = buildSnapshot(META, T0_OK, [queue("run:execute", "w.ts", 5)], undefined);
    const after = buildSnapshot(META, T0_OK, [queue("run:execute", "w.ts", 500)], undefined);
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true);
    expect(renderDrift(drift)).toEqual([
      "no drift (facts, T0, INV-1, and judgement C all unchanged)",
    ]);
  });

  it("detects added / removed / value-changed facts", () => {
    const before = buildSnapshot(
      META,
      T0_OK,
      [queue("keep", "a.ts", 1), queue("gone", "b.ts", 1, "old")],
      undefined,
    );
    const after = buildSnapshot(
      META,
      T0_OK,
      [queue("keep", "a.ts", 1), queue("new", "c.ts", 1), queue("gone", "b.ts", 1, "new")],
      undefined,
    );
    // "gone" keeps its identity (signal+name+filePath) but its detail flips old→new: a value-change, not a removal.
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(false);
    expect(drift.addedFacts.map((f) => f.name)).toEqual(["new"]);
    expect(drift.removedFacts).toEqual([]);
    expect(drift.changedFacts).toHaveLength(1);
    expect(drift.changedFacts[0]?.before.detail).toBe("old");
    expect(drift.changedFacts[0]?.after.detail).toBe("new");
    const report = renderDrift(drift).join("\n");
    expect(report).toContain("+ fact");
    expect(report).toContain("old → new");
  });

  it("an INV-1 write point flipping to unanalyzable IS drift (not silently clean)", () => {
    const wp = (verdict: "allowed" | "unanalyzable") => ({
      ran: true as const,
      writePoints: [
        {
          filePath: "f.ts",
          line: 1,
          table: "runs",
          columns: ["status"] as string[],
          verdict,
          reason: "",
          snippet: "",
        },
      ],
      candidateFiles: 1,
      filesScanned: 1,
      timingMs: 1,
    });
    const before = buildSnapshot(META, T0_OK, [], wp("allowed"));
    const after = buildSnapshot(META, T0_OK, [], wp("unanalyzable"));
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(false); // coverage loss must not read as "no drift"
    expect(drift.inv1Delta.unanalyzable).toBe(1);
    expect(renderDrift(drift).join("\n")).toContain("INV-1 unanalyzable +1");
  });

  it("an adapter bump with identical target state is clean but the bump is still surfaced", () => {
    const before = buildSnapshot(
      { ...META, adapterVersion: "synthetic-facts-1" },
      T0_OK,
      [queue("a", "a.ts", 1)],
      undefined,
    );
    const after = buildSnapshot(
      { ...META, adapterVersion: "synthetic-facts-2" },
      T0_OK,
      [queue("a", "a.ts", 9)],
      undefined,
    );
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true); // adapter bump ≠ target drift; line shift ≠ drift
    const report = renderDrift(drift);
    expect(report[0]).toContain("adapter version changed");
    expect(report).toContain("no target drift (only the adapter version changed)");
  });

  it('an adapter bump that ALSO changed edges never says "only the adapter version changed"', () => {
    // Both non-model axes moving at once used to render a line that
    // contradicted itself: "only the adapter version changed" printed right
    // below a group that had just listed a new edge. A reader cannot tell
    // which half to believe — the exact failure mode (`a signal misreporting
    // its own cause`) this command has had to fix repeatedly.
    const beforeFacts = [edgeFact("apps/web/a.ts", "postgres", "datastore")];
    const afterFacts = [
      edgeFact("apps/web/a.ts", "postgres", "datastore"),
      edgeFact("apps/web/a.ts", "redis", "queue"),
    ];
    const before = buildSnapshot(
      { ...META, adapterVersion: "synthetic-facts-1" },
      T0_OK,
      beforeFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(beforeFacts, [WEB], true),
    );
    const after = buildSnapshot(
      { ...META, adapterVersion: "synthetic-facts-2" },
      T0_OK,
      afterFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(afterFacts, [WEB], true),
    );
    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true); // edges are excluded from `clean` (issue #38)
    expect(drift.addedEdges.length).toBeGreaterThan(0);
    const report = renderDrift(drift);
    expect(report.some((l) => l.includes("only the adapter version changed"))).toBe(false);
    // Both axes that DID move are named in the one verdict line.
    const verdict = report.find((l) => l.startsWith("no model-side drift"));
    expect(verdict).toBeDefined();
    // Both non-model axes that DID move are named, neither claims exclusivity.
    expect(verdict).toContain("the adapter version changed too");
    expect(verdict).toContain("topology edges DID change");
  });

  it("flags an adapter version bump so fact churn isn't mistaken for real drift", () => {
    const before = buildSnapshot(
      { ...META, adapterVersion: "synthetic-facts-1" },
      T0_OK,
      [queue("a", "a.ts", 1)],
      undefined,
    );
    const after = buildSnapshot(
      { ...META, adapterVersion: "synthetic-facts-2" },
      T0_OK,
      [queue("b", "a.ts", 1)],
      undefined,
    );
    const drift = diffSnapshots(before, after);
    expect(drift.adapterBumped).toBe(true);
    expect(renderDrift(drift)[0]).toContain("adapter version changed");
  });

  it("write→load round-trips; a schema mismatch loads as undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-snap-"));
    try {
      const snap = buildSnapshot(META, T0_OK, [queue("q", "a.ts", 1)], undefined);
      const path = join(dir, "sub", "snapshot.json");
      await writeSnapshot(path, snap); // also proves mkdir -p of a nested dir
      expect(await loadSnapshot(path)).toEqual(snap);

      const bad = join(dir, "bad.json");
      await writeFile(bad, JSON.stringify({ ...snap, schemaVersion: 999 }));
      expect(await loadSnapshot(bad)).toBeUndefined();
      expect(await loadSnapshot(join(dir, "missing.json"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a v1-shaped snapshot (no `backtest`/`coverageRatio` keys — schema bumped 1→2 when they were added) loads as undefined, not a crash", async () => {
    // The exact failure the schema bump exists to prevent: a nightly artifact
    // written by the currently-published version (schemaVersion 1, no
    // `backtest` key at all) getting accepted by `loadSnapshot` and then
    // blowing up `diffSnapshots`/`renderSnapshotSummary` on `.backtest.ran`
    // of `undefined`. `loadSnapshot`'s version gate must reject it outright.
    const dir = await mkdtemp(join(tmpdir(), "codeontic-snap-v1-"));
    try {
      const v1Shaped = {
        schemaVersion: 1,
        adapterVersion: "old",
        generatedAt: "2026-01-01T00:00:00.000Z",
        t0: { ok: true, errors: 0, warnings: 0 },
        inv1: { ran: false, violations: 0, unanalyzable: 0, writePoints: 0 },
        facts: [],
        factCount: 0,
        timingMs: 1,
        // deliberately NO `backtest`, NO `coverageRatio` — that's the point.
      };
      const path = join(dir, "v1.json");
      await writeFile(path, JSON.stringify(v1Shaped));
      expect(await loadSnapshot(path)).toBeUndefined();

      // And the caller-facing consequence: `--drift` against it must take
      // the already-written "no readable prior snapshot" path, not throw.
      const curr = buildSnapshot(META, T0_OK, [], undefined);
      const prior = await loadSnapshot(path);
      expect(prior).toBeUndefined();
      if (prior) diffSnapshots(prior, curr); // unreachable — the point is prior IS undefined
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a null 判据 C ratio (no covered files) round-trips through JSON as null, never Infinity/undefined — JSON.stringify(Infinity) silently becomes the string "null" and would poison this exact round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-snap-ratio-"));
    try {
      const snap = buildSnapshot(META, T0_OK, [], undefined); // no backtest → ZERO_COVERAGE_RATIO default, ratio: null
      expect(snap.coverageRatio.ratio).toBeNull();
      const path = join(dir, "s.json");
      await writeSnapshot(path, snap);
      const loaded = await loadSnapshot(path);
      expect(loaded?.coverageRatio.ratio).toBeNull();
      expect(loaded).toEqual(snap);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runSnapshot does a real full scan over a git repo (facts + commit + T0)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codeontic-snap-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(
        join(repo, "src", "w.ts"),
        "const RUN_QUEUE = `run:execute${S}`;\nsetInterval(f, 5000);",
      );
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "x"], { cwd: repo });
      await seedSyntheticModel(repo); // seeds <repo>/.codeontic/model — targetDir === repoRoot here

      const snap = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
        adapter: syntheticAdapter,
      });
      expect(snap.factCount).toBeGreaterThanOrEqual(1);
      expect(snap.facts.some((f) => f.name === "run:execute")).toBe(true);
      expect(snap.commit).toMatch(/^[0-9a-f]{40}$/); // real HEAD sha, resolved by runSnapshot
      expect(snap.t0.ok).toBe(true); // seeded synthetic model is valid
      expect(renderSnapshotSummary(snap)).toContain("synthetic-facts-1");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("runSnapshot without a repoRoot still produces a model-only snapshot (T0, no facts)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-snap-modelonly-"));
    try {
      await seedSyntheticModel(dir);
      const snap = await runSnapshot(dir, { generatedAt: "2026-01-01T00:00:00.000Z" });
      expect(snap.factCount).toBe(0);
      expect(snap.commit).toBeUndefined();
      expect(snap.inv1.ran).toBe(false);
      expect(snap.t0.ok).toBe(true);
      expect(snap.backtest.ran).toBe(false); // no repoRoot → backtest not run either
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runSnapshot wires up a real 判据 A backtest whenever repoRoot is given — even with no adapter/facts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codeontic-snap-backtest-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src", "w.ts"), "export const a = 1;");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "x"], { cwd: repo });
      await seedSyntheticModel(repo); // anchors src/synth/*.ts — src/w.ts is NOT one of them

      // No `adapter` option at all — proves backtest doesn't need facts/adapter.
      const snap = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(snap.backtest.ran).toBe(true);
      expect(snap.backtest.overall.total).toBe(1); // the one .ts-touching commit
      expect(snap.backtest.overall.hit).toBe(0); // src/w.ts isn't model-anchored
      expect(snap.backtest.componentsDeclared).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("the persisted snapshot is valid JSON with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-snap-json-"));
    try {
      const path = join(dir, "s.json");
      await writeSnapshot(path, buildSnapshot(META, T0_OK, [], undefined));
      const raw = await readFile(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(raw) as Snapshot).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── edge-granularity topology drift (issue #23 阶段2 Q2) ────────────────

const WEB: Component = { id: "web", role: "frontend", paths: ["apps/web"] };

describe("edge-granularity topology drift (issue #23 阶段2 Q2) — buildSnapshot/diffSnapshots, pure", () => {
  it("buildSnapshot excludes topology-tagged facts from `facts`/`factCount` — they drift at edge granularity instead, via `topologyEdges`", () => {
    const snap = buildSnapshot(
      META,
      T0_OK,
      [queue("keep", "a.ts", 1), edgeFact("b.ts", "postgres", "datastore")],
      undefined,
    );
    expect(snap.facts.map((f) => f.name)).toEqual(["keep"]);
    expect(snap.factCount).toBe(1);
    // No topologyModel (7th arg) was passed — edges are simply empty, not an error.
    expect(snap.topologyEdges).toEqual([]);
  });

  it("moving a topology-tagged call site to a different file in the SAME component is neither fact drift nor edge drift — the core guarantee this feature exists for", () => {
    const beforeFacts = [edgeFact("apps/web/a.ts", "postgres", "datastore")];
    const afterFacts = [edgeFact("apps/web/b.ts", "postgres", "datastore")]; // same component, different file
    const before = buildSnapshot(
      META,
      T0_OK,
      beforeFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(beforeFacts, [WEB], true),
    );
    const after = buildSnapshot(
      META,
      T0_OK,
      afterFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(afterFacts, [WEB], true),
    );
    expect(before.topologyEdges).toEqual([{ from: "web", to: "postgres", toKind: "datastore" }]);
    expect(after.topologyEdges).toEqual([{ from: "web", to: "postgres", toKind: "datastore" }]);

    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true);
    expect(drift.addedFacts).toEqual([]);
    expect(drift.removedFacts).toEqual([]);
    expect(drift.addedEdges).toEqual([]);
    expect(drift.removedEdges).toEqual([]);
    expect(renderDrift(drift)).toEqual([
      "no drift (facts, T0, INV-1, and judgement C all unchanged)",
    ]);
  });

  /**
   * A BROKEN components config must not masquerade as an architecture change.
   *
   * Every edge's `from` is resolved through the declared components, so if an
   * unreadable config degrades to "no components", every edge is re-homed or
   * lost and the next diff reports the whole architecture as deleted. Measured
   * on a real target before this was fixed: one typo (`frontend` → `frontEnd`)
   * took 36 edges to 9 and produced 43 edge changes, with nothing in the
   * output saying a config typo was the cause. A signal lying about its own
   * cause is worse than a silent one — it sends the reader hunting for a change
   * that never happened.
   */
  it("skips the edge comparison (rather than reporting every edge removed) when one side's edges are unavailable", () => {
    const facts = [edgeFact("apps/web/a.ts", "postgres", "datastore")];
    const healthy = buildSnapshot(
      META,
      T0_OK,
      facts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(facts, [WEB], true),
    );
    // What runSnapshot produces when `loadComponents` returns an error.
    const broken = buildSnapshot(
      META,
      T0_OK,
      facts,
      undefined,
      undefined,
      undefined,
      undefined,
      "components config could not be read: bad role",
    );
    // null, NOT [] — "could not compute" and "genuinely none" are opposite facts.
    expect(broken.topologyEdges).toBeNull();
    expect(broken.topologyEdgesUnavailable).toContain("bad role");
    expect(healthy.topologyEdges).toEqual([{ from: "web", to: "postgres", toKind: "datastore" }]);

    const drift = diffSnapshots(healthy, broken);
    // The edge that still exists in code is NOT reported as removed.
    expect(drift.removedEdges).toEqual([]);
    expect(drift.addedEdges).toEqual([]);
    expect(drift.edgesSkippedReason).toContain("bad role");
    // The skip is stated out loud, and the verdict does not claim edges were checked.
    const rendered = renderDrift(drift);
    expect(rendered.some((l) => l.includes("edge comparison SKIPPED"))).toBe(true);
    expect(rendered.some((l) => l.includes("edges not compared"))).toBe(true);
    expect(rendered).not.toContain("no drift (facts, T0, INV-1, and judgement C all unchanged)");

    // Symmetric: a broken PREVIOUS snapshot is skipped the same way.
    const reverse = diffSnapshots(broken, healthy);
    expect(reverse.addedEdges).toEqual([]);
    expect(reverse.edgesSkippedReason).toContain("previous snapshot");
  });

  it("a run with nothing to compute still reports [] — only a FAILURE is null", () => {
    // Guards the distinction the fix rests on: no repo-root/adapter is a real
    // "no edges", and must stay tellable apart from a broken config.
    const snap = buildSnapshot(META, T0_OK, [], undefined, undefined, undefined, undefined);
    expect(snap.topologyEdges).toEqual([]);
    expect(snap.topologyEdgesUnavailable).toBeUndefined();
  });

  it("a component calling a NEW target it never called before IS edge drift, but (issue #38) does NOT flip `clean` — only the always-visible topology-edges group shows it", () => {
    const beforeFacts = [edgeFact("apps/web/a.ts", "postgres", "datastore")];
    const afterFacts = [
      edgeFact("apps/web/a.ts", "postgres", "datastore"),
      edgeFact("apps/web/a.ts", "redis", "queue"),
    ];
    const before = buildSnapshot(
      META,
      T0_OK,
      beforeFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(beforeFacts, [WEB], true),
    );
    const after = buildSnapshot(
      META,
      T0_OK,
      afterFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(afterFacts, [WEB], true),
    );

    const drift = diffSnapshots(before, after);
    // The core reversal this issue makes: a new edge is real, visible drift
    // (asserted below), but no longer part of `clean` — a new outbound call
    // target is normal development activity, not "something that shouldn't
    // have happened" (see `SnapshotDrift.clean`'s doc).
    expect(drift.clean).toBe(true);
    expect(drift.addedEdges).toEqual([{ from: "web", to: "redis", toKind: "queue" }]);
    expect(drift.removedEdges).toEqual([]);
    // Still no fact-level noise — the new call site is a topology fact too,
    // so it's excluded from addedFacts just like the unchanged one above.
    expect(drift.addedFacts).toEqual([]);
    expect(drift.removedFacts).toEqual([]);
    expect(renderDrift(drift)).toContain("+ edge web → redis (queue)");
  });

  it("an edge disappearing (a target no longer called) IS edge drift too, and also does NOT flip `clean`", () => {
    const beforeFacts = [
      edgeFact("apps/web/a.ts", "postgres", "datastore"),
      edgeFact("apps/web/a.ts", "redis", "queue"),
    ];
    const afterFacts = [edgeFact("apps/web/a.ts", "postgres", "datastore")];
    const before = buildSnapshot(
      META,
      T0_OK,
      beforeFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(beforeFacts, [WEB], true),
    );
    const after = buildSnapshot(
      META,
      T0_OK,
      afterFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(afterFacts, [WEB], true),
    );

    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true);
    expect(drift.removedEdges).toEqual([{ from: "web", to: "redis", toKind: "queue" }]);
    expect(drift.addedEdges).toEqual([]);
    expect(renderDrift(drift)).toContain("- edge web → redis (queue)");
  });

  it("a new edge stays fully visible AND machine-readable even though `clean` is true — the report never hides it behind the early `clean` return, and the PR-job consumption contract (`addedEdges`, see `SnapshotDrift.addedEdges`'s doc) survives a JSON round-trip", () => {
    const beforeFacts = [edgeFact("apps/web/a.ts", "postgres", "datastore")];
    const afterFacts = [
      edgeFact("apps/web/a.ts", "postgres", "datastore"),
      edgeFact("apps/web/a.ts", "redis", "queue"),
    ];
    const before = buildSnapshot(
      META,
      T0_OK,
      beforeFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(beforeFacts, [WEB], true),
    );
    const after = buildSnapshot(
      META,
      T0_OK,
      afterFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(afterFacts, [WEB], true),
    );

    const drift = diffSnapshots(before, after);
    expect(drift.clean).toBe(true);

    const rendered = renderDrift(drift);
    // Both the dedicated topology-edges group AND the "no [model] drift"
    // verdict line are present — proving the `clean` early-return in
    // `renderDrift` does not swallow the edge group printed just above it.
    expect(rendered.some((l) => l.startsWith("topology edges ("))).toBe(true);
    expect(rendered).toContain("+ edge web → redis (queue)");
    expect(rendered.some((l) => l.startsWith("no drift (facts, T0, INV-1, and judgement C"))).toBe(
      true,
    );

    // Machine-readable: `addedEdges` is what a PR job would read (via
    // `diffSnapshots`) to know which edges a PR introduced — plain
    // `{ from, to, toKind? }` objects, directly JSON-serializable with no
    // lossy round-trip.
    expect(JSON.parse(JSON.stringify(drift.addedEdges))).toEqual(drift.addedEdges);
    expect(drift.addedEdges).toEqual([{ from: "web", to: "redis", toKind: "queue" }]);
  });

  it("a real MODEL-side signal (a plain fact) still flips `clean` even when a topology edge ALSO changed in the same diff — and the edge line renders exactly ONCE, in its own group, not duplicated into the fact-lines section it used to share", () => {
    const beforeFacts = [
      queue("keep", "a.ts", 1),
      edgeFact("apps/web/a.ts", "postgres", "datastore"),
    ];
    const afterFacts = [
      queue("keep", "a.ts", 1),
      queue("new", "c.ts", 1), // MODEL-side signal: a genuinely new fact.
      edgeFact("apps/web/a.ts", "postgres", "datastore"),
      edgeFact("apps/web/a.ts", "redis", "queue"), // topology-side: a genuinely new edge.
    ];
    const before = buildSnapshot(
      META,
      T0_OK,
      beforeFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(beforeFacts, [WEB], true),
    );
    const after = buildSnapshot(
      META,
      T0_OK,
      afterFacts,
      undefined,
      undefined,
      undefined,
      computeTopologyModel(afterFacts, [WEB], true),
    );

    const drift = diffSnapshots(before, after);
    // The fact addition is real MODEL-side drift — `clean` still flips false
    // for it, exactly as before this change. The edge addition riding along
    // in the SAME diff must not mask, duplicate, or otherwise interfere.
    expect(drift.clean).toBe(false);
    expect(drift.addedFacts.map((f) => f.name)).toEqual(["new"]);
    expect(drift.addedEdges).toEqual([{ from: "web", to: "redis", toKind: "queue" }]);

    const rendered = renderDrift(drift);
    expect(rendered.some((l) => l.startsWith("topology edges ("))).toBe(true);
    expect(rendered.some((l) => l.startsWith("+ fact") && l.includes("new"))).toBe(true);
    // Load-bearing: exactly one occurrence. The edge-rendering loop used to
    // live in this same dirty-path block, right after the fact lines — a
    // careless re-add of that loop here (e.g. by a future refactor) would
    // print this line twice without any assertion elsewhere catching it.
    expect(rendered.filter((l) => l === "+ edge web → redis (queue)")).toHaveLength(1);
  });

  it("a v2-shaped snapshot (no `topologyEdges` key — schema bumped 2→3 when it was added) loads as undefined, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-snap-v2-"));
    try {
      const v2Shaped = {
        schemaVersion: 2,
        adapterVersion: "old",
        generatedAt: "2026-01-01T00:00:00.000Z",
        t0: { ok: true, errors: 0, warnings: 0 },
        inv1: { ran: false, violations: 0, unanalyzable: 0, writePoints: 0 },
        facts: [],
        factCount: 0,
        backtest: {
          ran: false,
          ref: "HEAD",
          windowRequested: 50,
          commitsScanned: 0,
          scanCapped: false,
          anchoredFileCount: 0,
          overall: { hit: 0, total: 0 },
          byRole: [],
          byComponent: [],
          componentsDeclared: false,
        },
        coverageRatio: {
          nodes: { loop: 0, loopDormant: 0, flow: 0, junction: 0, total: 0, anchored: 0 },
          information: {
            activeLoops: 0,
            loopsWithScenario: 0,
            loopsWithBoundary: 0,
            loopsWithMechanism: 0,
            junctionsWithScenario: 0,
          },
          coveredFileCount: 0,
          ratio: null,
          ratioAllNodes: null,
        },
        timingMs: 1,
        // deliberately NO `topologyEdges` key — that's the point.
      };
      const path = join(dir, "v2.json");
      await writeFile(path, JSON.stringify(v2Shaped));
      expect(await loadSnapshot(path)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("edge-granularity topology drift (issue #23 阶段2 Q2) — runSnapshot, end-to-end over a real repo", () => {
  async function initRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "codeontic-snap-edge-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, ".codeontic"), { recursive: true });
    // ONE component covering the whole `src` tree — moving a call site
    // between two files under `src` must stay inside this one component.
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({ components: [{ id: "worker", role: "worker", paths: ["src"] }] }),
      "utf8",
    );
    await seedSyntheticModel(repo);
    return repo;
  }

  function commit(repo: string, msg: string): void {
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", msg], { cwd: repo });
  }

  it("moving a topology-tagged call site to a different file in the same component produces no drift end-to-end", async () => {
    const repo = await initRepo();
    try {
      await writeFile(join(repo, "src", "a.ts"), "CALL_DB();\n");
      commit(repo, "call db from a.ts");
      const before = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
        adapter: syntheticAdapter,
        cacheDir: null,
      });
      expect(before.topologyEdges).toEqual([
        { from: "worker", to: "postgres", toKind: "datastore" },
      ]);

      await rm(join(repo, "src", "a.ts"));
      await writeFile(join(repo, "src", "b.ts"), "CALL_DB();\n");
      commit(repo, "move the call site to b.ts");
      const after = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:01.000Z",
        adapter: syntheticAdapter,
        cacheDir: null,
      });
      expect(after.topologyEdges).toEqual([
        { from: "worker", to: "postgres", toKind: "datastore" },
      ]);

      const drift = diffSnapshots(before, after);
      expect(drift.clean).toBe(true); // the call site moved, the ARCHITECTURE didn't
      expect(drift.addedEdges).toEqual([]);
      expect(drift.removedEdges).toEqual([]);
      expect(drift.addedFacts).toEqual([]);
      expect(drift.removedFacts).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("adding a NEW call target is edge drift end-to-end, even from an already-connected component, but (issue #38) does NOT flip `clean` end-to-end either", async () => {
    const repo = await initRepo();
    try {
      await writeFile(join(repo, "src", "a.ts"), "CALL_DB();\n");
      commit(repo, "call db");
      const before = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
        adapter: syntheticAdapter,
        cacheDir: null,
      });

      await writeFile(join(repo, "src", "a.ts"), "CALL_DB();\nCALL_REDIS();\n");
      commit(repo, "also call redis");
      const after = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:01.000Z",
        adapter: syntheticAdapter,
        cacheDir: null,
      });

      const drift = diffSnapshots(before, after);
      // Same reversal as the pure unit test above, now exercised through a
      // real `runSnapshot` scan: a genuinely new edge is real drift (still
      // reported below) but no longer flips `clean` (issue #38).
      expect(drift.clean).toBe(true);
      expect(drift.addedEdges).toEqual([{ from: "worker", to: "redis", toKind: "queue" }]);
      expect(drift.removedEdges).toEqual([]);
      expect(renderDrift(drift)).toContain("+ edge worker → redis (queue)");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("`codeontic snapshot --drift-json` — machine-readable drift for PR-time delivery (issue #38)", () => {
  // Issue #38 moved topology edges OUT of `clean` on purpose, which makes
  // nightly the wrong place to expect anyone to notice a new service call.
  // The delivery it asks for instead is PR-time: a job diffs its base
  // snapshot against the PR and tells the author on the spot. `package.json`
  // ships `bin` only (no `main`/`exports`), so a CI job cannot import
  // `diffSnapshots` — this flag is the only way for that job to exist.
  // stdout and stderr kept SEPARATE on purpose: `--drift-json` promises one
  // JSON value on stdout while still sending the adapter status banner to
  // stderr, so a helper that merged the two streams could not tell a real
  // contract violation from a banner doing exactly what it should.
  const makeIo = () => {
    const logs: string[] = [];
    const errs: string[] = [];
    return {
      io: { log: (l: string) => logs.push(l), error: (l: string) => errs.push(l) },
      logs,
      errs,
    };
  };

  async function seedRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "codeontic-drift-json-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await seedSyntheticModel(repo);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
    return repo;
  }

  it("emits exactly one JSON value carrying the drift — the shape a PR job parses", async () => {
    const repo = await seedRepo();
    try {
      const prior = join(repo, "prior.json");
      await run(["snapshot", repo, "--repo-root", repo, "--out", prior], makeIo().io);

      const { io, logs } = makeIo();
      const exitCode = await run(
        ["snapshot", repo, "--repo-root", repo, "--drift", prior, "--drift-json"],
        io,
      );
      expect(exitCode).toBe(0);
      // Exactly one log call — no summary line, no "wrote ..." line mixed in,
      // so `logs[0]` alone is always valid JSON for a consumer piping stdout
      // straight into `JSON.parse`.
      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0] ?? "") as {
        ran: boolean;
        edges: { comparable: boolean; reason?: string };
        drift: { addedEdges: unknown[]; removedEdges: unknown[]; clean: boolean };
      };
      expect(parsed.ran).toBe(true);
      // These repos carry no adapter, so nothing was extracted — the payload
      // MUST say so. Without this a PR job reads `addedEdges: []` and reports
      // "no new edges" on every PR forever, which is the silent pass the whole
      // PR-time delivery exists to prevent.
      // The reason is now produced by the snapshot itself rather than
      // re-derived from the flags in the CLI (two places inferring the same
      // state disagreed about it); assert on the SUBSTANCE — that it names the
      // adapter and says the extraction did not run — not on the old phrasing.
      expect(parsed.edges.comparable).toBe(false);
      expect(parsed.edges.reason).toContain("adapter");
      expect(parsed.edges.reason).toContain("never ran");
      // The two fields a PR job actually reads must survive the round trip as
      // arrays — this is the machine-readable contract issue #38 depends on.
      expect(Array.isArray(parsed.drift.addedEdges)).toBe(true);
      expect(Array.isArray(parsed.drift.removedEdges)).toBe(true);
      expect(typeof parsed.drift.clean).toBe("boolean");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("still writes the snapshot artifact — the flag changes what the command SAYS, not what it produces", async () => {
    const repo = await seedRepo();
    try {
      const prior = join(repo, "prior.json");
      await run(["snapshot", repo, "--repo-root", repo, "--out", prior], makeIo().io);
      const out = join(repo, "after.json");
      await run(
        ["snapshot", repo, "--repo-root", repo, "--out", out, "--drift", prior, "--drift-json"],
        makeIo().io,
      );
      // Suppressing the "wrote ..." line must not suppress the write itself:
      // a nightly that adopts this flag would otherwise silently stop
      // producing the artifact every later run diffs against.
      expect(await loadSnapshot(out)).not.toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("an unreadable prior snapshot still emits exactly one JSON value, never the ⚠ text line plus JSON", async () => {
    const repo = await seedRepo();
    try {
      const { io, logs } = makeIo();
      const exitCode = await run(
        [
          "snapshot",
          repo,
          "--repo-root",
          repo,
          "--drift",
          join(repo, "does-not-exist.json"),
          "--drift-json",
        ],
        io,
      );
      expect(exitCode).toBe(0);
      expect(logs).toHaveLength(1); // NOT "⚠ --drift: no readable prior snapshot" + a JSON blob
      const parsed = JSON.parse(logs[0] ?? "") as { ran: boolean; skippedReason: string };
      expect(parsed.ran).toBe(false);
      expect(parsed.skippedReason).toContain("no readable prior snapshot");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reports edges as NOT comparable when --repo-root is missing — nothing was scanned", async () => {
    const repo = await seedRepo();
    try {
      const prior = join(repo, "prior.json");
      await run(["snapshot", repo, "--repo-root", repo, "--out", prior], makeIo().io);
      const { io, logs } = makeIo();
      // No --repo-root: `runSnapshot` never calls `runFacts`, so the edge set is
      // empty because nothing was SCANNED, not because nothing was added. A PR
      // job that forgot the flag would otherwise report "no new edges" forever.
      const exitCode = await run(["snapshot", repo, "--drift", prior, "--drift-json"], io);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(logs[0] ?? "") as {
        edges: { comparable: boolean; reason?: string };
      };
      expect(parsed.edges.comparable).toBe(false);
      expect(parsed.edges.reason).toContain("no --repo-root");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("--drift-json without --drift is a loud CLI-misuse error, not a forever-empty report", async () => {
    const repo = await seedRepo();
    try {
      const { io, errs } = makeIo();
      const exitCode = await run(["snapshot", repo, "--repo-root", repo, "--drift-json"], io);
      // Left to emit `{ran:false}` it would report "no new edges" on every PR
      // forever — a typo that reads exactly like a passing check.
      expect(exitCode).toBe(1);
      expect(errs.some((l) => l.includes("--drift-json requires --drift"))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("without --drift-json the drift output stays human-readable (no JSON leaks into the nightly log)", async () => {
    const repo = await seedRepo();
    try {
      const prior = join(repo, "prior.json");
      await run(["snapshot", repo, "--repo-root", repo, "--out", prior], makeIo().io);
      const { io, logs } = makeIo();
      await run(["snapshot", repo, "--repo-root", repo, "--drift", prior], io);
      expect(logs.length).toBeGreaterThan(1);
      expect(logs.some((l) => l.startsWith("wrote "))).toBe(true);
      expect(() => JSON.parse(logs[0] ?? "")).toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/**
 * issue #48 — the FOURTH cause of an empty `topologyEdges`, and the one that
 * used to walk straight into `comparable: true`.
 *
 * #46 made the edge status fields REQUIRED because `addedEdges: []` has causes
 * a PR gate must tell apart: nothing added, no adapter, no repo root. It missed
 * this one — adapter resolved, repo root given, and the SCAN ITSELF failed. The
 * observable damage is a PR comment reading "no service-call edges were added
 * or removed" with no pipeline-failure note anywhere, which is a signal lying
 * about its own cause: strictly worse than a silent one, because it sends the
 * reader looking for an architecture change that never happened.
 *
 * The repro is the issue's own: a `candidatePattern` that is a legal JS regex
 * but illegal for `git grep -E`, so the grep exits non-zero and `runFacts`
 * honestly reports `ran: false` with zero facts.
 */
describe("snapshot — a failed fact scan is never an empty edge set (issue #48)", () => {
  const brokenScanAdapter: Adapter = {
    ...syntheticAdapter,
    version: "broken-scan-1",
    candidatePattern: "(?=CALL_DB)", // lookahead: fine for JS, fatal for `git grep -E`
  };

  async function seedScanRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "codeontic-snap-scanfail-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, ".codeontic"), { recursive: true });
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({ components: [{ id: "worker", role: "worker", paths: ["src"] }] }),
      "utf8",
    );
    await writeFile(join(repo, "src", "a.ts"), "CALL_DB();\n");
    await seedSyntheticModel(repo);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
    return repo;
  }

  it("records topologyEdges: null with a reason instead of [] when the scan did not run", async () => {
    const repo = await seedScanRepo();
    try {
      const snapshot = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
        adapter: brokenScanAdapter,
        cacheDir: null,
      });
      expect(snapshot.factCount).toBe(0); // the scan produced nothing...
      expect(snapshot.topologyEdges).toBeNull(); // ...and says WHY, rather than "[]"
      expect(snapshot.topologyEdgesUnavailable).toContain("fact extraction did not run");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("makes the drift uncomparable when the BASE scan failed, with a non-empty reason", async () => {
    const repo = await seedScanRepo();
    try {
      const base = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
        adapter: brokenScanAdapter,
        cacheDir: null,
      });
      const head = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:01.000Z",
        adapter: syntheticAdapter,
        cacheDir: null,
      });

      const drift = diffSnapshots(base, head);
      // `edgesSkippedReason` is exactly what run.ts projects into
      // `--drift-json`'s `edges: {comparable:false, reason}`.
      expect(drift.edgesSkippedReason).toBeTruthy();
      expect(drift.edgesSkippedReason).toContain("previous snapshot");
      expect(drift.edgesSkippedReason).toContain("fact extraction did not run");
      // The real edges on the head side must NOT be reported as "added".
      expect(drift.addedEdges).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("makes the drift uncomparable when the HEAD scan failed, with a non-empty reason", async () => {
    const repo = await seedScanRepo();
    try {
      const base = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:00.000Z",
        adapter: syntheticAdapter,
        cacheDir: null,
      });
      expect(base.topologyEdges).toEqual([{ from: "worker", to: "postgres", toKind: "datastore" }]);

      const head = await runSnapshot(repo, {
        repoRoot: repo,
        generatedAt: "2026-01-01T00:00:01.000Z",
        adapter: brokenScanAdapter,
        cacheDir: null,
      });

      const drift = diffSnapshots(base, head);
      expect(drift.edgesSkippedReason).toBeTruthy();
      expect(drift.edgesSkippedReason).toContain("current snapshot");
      // The pre-#48 bug in its most damaging form: a real edge reported as
      // REMOVED because the run that should have seen it never happened.
      expect(drift.removedEdges).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
