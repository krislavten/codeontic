import type { ModelGraph } from "../loader/model-graph.js";
import { coveredFiles } from "../validate/unregistered.js";

/**
 * 判据 A (issue #23 阶段 1 PR1) — "backtest": when someone actually changed
 * code, did the model have anything to say? Walks recent git history and
 * asks, per `.ts`/`.tsx`-touching commit, whether ANY changed file falls
 * under a model anchor. This is the COMMIT-side counterweight to `coverage`
 * (MODEL-side: how much of the model is anchored) and `reconcile`
 * (FACTS-side: which extracted facts the model doesn't register) — all
 * three answer different questions and none substitutes for another.
 *
 * Deliberately built on `coveredFiles` from validate/unregistered.ts, NOT on
 * `reconcileFacts`'s output. `coveredFiles` is a pure function of the
 * ModelGraph alone (Loop.anchors + Flow.anchors + Junction evidence anchors,
 * active + dormant) — it takes no facts and cannot be moved by how facts get
 * matched to files. A sibling change widens what `reconcileFacts` counts as
 * "registered" by following one hop of delegation; if this backtest read
 * THAT set instead, a change that makes reconciliation more lenient would
 * silently inflate the very number graded to judge whether modeling is
 * happening — a measurement that can be moved by the thing it measures is
 * not a measurement (see issue #23's 判据 C, which exists specifically to
 * catch "灌覆盖": gaming coverage without real modeling).
 */

/**
 * Which commit the MODEL itself was read from — distinct from
 * `BacktestReport.ref`, which only pins the COMMIT WINDOW scanned. The model
 * (anchors, node counts) is always read off the live working tree, same as
 * every other codeontic command (`coverage`, `conformance`, ...) — `--ref`
 * never checks it out at a historical point. Two checkouts at different
 * points in history (or one with uncommitted model edits) will legitimately
 * report different `anchoredFileCount`/`coverageRatio` numbers for the exact
 * same `--ref`; this is what makes that reproducible rather than "looks
 * broken". Plain data (no git access from this file — see
 * src/cli/commands/backtest.ts's `readGitInfo` call for how it's produced).
 */
export interface ModelRef {
  /** `git rev-parse HEAD` of the model's directory, or null outside a git checkout / no commits yet. */
  head: string | null;
  /** `git status --porcelain` non-empty, or null when `head` is null. */
  dirty: boolean | null;
}

/** A single qualifying commit for the backtest window: changed >=1 `.ts`/`.tsx` file. */
export interface BacktestCommit {
  sha: string;
  /** repo-relative changed files, ALREADY filtered to the `.ts`/`.tsx` extension. */
  tsFiles: string[];
}

/** hit/total pair with the percentage left to the formatter (never baked in — a
 * consumer diffing two of these needs the raw counts, not a rounded string). */
export interface BacktestStat {
  hit: number;
  total: number;
}

export interface BacktestPartitionStat extends BacktestStat {
  id: string;
  label: string;
}

/** What a component partitioner resolves a file to — deliberately just
 * `{id, label, role}`, not the full `Component` shape from
 * src/config/components.ts. Keeping this file decoupled from that module
 * means the backtest core here needs no changes when the config format
 * evolves; only the CLI orchestrator (src/cli/commands/backtest.ts) imports
 * it. `role` is a plain string here (not the closed `ComponentRole` union —
 * that union lives in the config module) so this file stays opaque to what
 * roles even exist; it just groups by whatever string it's handed. */
export interface ComponentDescriptor {
  id: string;
  label: string;
  role: string;
}

/** Resolves which component owns a repo-relative file, or undefined if none does. */
export type ComponentResolver = (repoRelativePath: string) => ComponentDescriptor | undefined;

export interface BacktestPartitioning {
  /** Every declared component, in declaration order — seeds the by-component
   * output even for a component that ends up 0/0 in this window (silently
   * dropping a declared-but-untouched component would read as "not
   * declared", a different and more alarming fact than "declared, quiet this
   * window"). The by-role breakdown derives its row set and order from the
   * FIRST appearance of each role in this same list — no separate role list
   * to keep in sync, and no hardcoded role vocabulary in this file. */
  declared: readonly ComponentDescriptor[];
  resolve: ComponentResolver;
}

/**
 * issue #23 §1: two INDEPENDENT aggregation levels, not one nested inside
 * the other. `byRole` answers "is the frontend/API/worker/... layer as a
 * WHOLE covered" (the question the issue's own framing — "模型对前端、API、
 * eval、发版链路基本失语" — is stated at); `byComponent` answers "which
 * SPECIFIC app". Both partition the SAME commit set, so **a commit can (and
 * routinely will) count toward more than one row in EACH table** — touching
 * a frontend app and a backend worker in one commit adds to both `frontend`
 * and `worker` in byRole, and to both of those two components' own rows in
 * byComponent. Do not sum a table's rows expecting `overall.total`: the
 * rows overlap by construction, so the sum is not a meaningful number.
 */
export interface BacktestComputation {
  /** size of the anchor-derived covered-file set (Loop+Flow anchors, Junction evidence). */
  anchoredFileCount: number;
  overall: BacktestStat;
  /** Empty when no partitioning was supplied (no components declared). */
  byComponent: BacktestPartitionStat[];
  /** Empty when no partitioning was supplied. One row per DISTINCT role
   * among the declared components (not the full COMPONENT_ROLES vocabulary —
   * a role nobody declared a component for gets no row, same "declared but
   * possibly 0/0" contract as byComponent, just one level up). */
  byRole: BacktestPartitionStat[];
}

/**
 * Pure core of the backtest: given the model graph and an already-collected
 * list of qualifying commits (see collectBacktestCommits in
 * src/cli/commands/backtest.ts for how those are walked off git), compute
 * the hit rate overall, per component, and per role.
 *
 * A commit "hits" when ANY of its changed `.ts`/`.tsx` files is in the
 * anchor-covered set — file-level, matching `reconcileFacts`'s granularity
 * (see that function's doc comment for why file-level is the deliberate,
 * sole granularity here too).
 *
 * INVARIANT (locked by a test): adding `partitioning` never changes
 * `overall` — partitioning is a pure read of the SAME commit set into two
 * additional breakdowns, it cannot feed back into the total.
 */
export function computeBacktest(
  graph: ModelGraph,
  commits: readonly BacktestCommit[],
  partitioning?: BacktestPartitioning,
): BacktestComputation {
  const covered = coveredFiles(graph);
  const isHit = (c: BacktestCommit): boolean => c.tsFiles.some((f) => covered.has(f));

  let hit = 0;
  for (const c of commits) if (isHit(c)) hit++;
  const overall: BacktestStat = { hit, total: commits.length };

  const byComponent: BacktestPartitionStat[] = [];
  const byRole: BacktestPartitionStat[] = [];
  if (partitioning) {
    const componentStats = new Map<string, BacktestPartitionStat>(
      partitioning.declared.map((d) => [d.id, { id: d.id, label: d.label, hit: 0, total: 0 }]),
    );
    // Role rows, seeded in first-declaration order (not sorted, not pulled
    // from an external role vocabulary — see BacktestPartitioning.declared).
    const roleOrder: string[] = [];
    const roleStats = new Map<string, BacktestPartitionStat>();
    for (const d of partitioning.declared) {
      if (!roleStats.has(d.role)) {
        roleStats.set(d.role, { id: d.role, label: d.role, hit: 0, total: 0 });
        roleOrder.push(d.role);
      }
    }

    for (const c of commits) {
      const commitHit = isHit(c);
      // A commit can touch >1 component (e.g. a shared type edited alongside
      // its frontend consumer), and >1 component can share a role — dedupe
      // BOTH independently so each counts once per component and once per
      // role, not once per matching file.
      const touchedComponentIds = new Set<string>();
      const touchedRoles = new Set<string>();
      for (const f of c.tsFiles) {
        const comp = partitioning.resolve(f);
        if (!comp) continue;
        touchedComponentIds.add(comp.id);
        touchedRoles.add(comp.role);
      }
      for (const id of touchedComponentIds) {
        const s = componentStats.get(id);
        // `resolve` can only ever name an id present in `declared` (the CLI
        // orchestrator builds both from the same component list) — but stay
        // defensive rather than assume that invariant across the boundary.
        if (!s) continue;
        s.total++;
        if (commitHit) s.hit++;
      }
      for (const role of touchedRoles) {
        const s = roleStats.get(role);
        if (!s) continue;
        s.total++;
        if (commitHit) s.hit++;
      }
    }
    for (const d of partitioning.declared) {
      const s = componentStats.get(d.id);
      if (s) byComponent.push(s);
    }
    for (const role of roleOrder) {
      const s = roleStats.get(role);
      if (s) byRole.push(s);
    }
  }

  return { anchoredFileCount: covered.size, overall, byComponent, byRole };
}

/**
 * 判据 C (issue #23 §1): node-to-covered-file ratio — the counterweight to
 * 判据 A. A grows if you point MORE code at the model; C catches the cheap
 * way to do that: adding nodes without adding real per-file anchoring
 * ("灌节点" — inflating the node count while the covered-file set stays
 * thin). The closer `ratio` sits to 1:1, the more the model reads as a
 * directory listing (one node per file) rather than an abstraction (several
 * files' worth of behavior collapsed into one modeled loop/flow/junction).
 *
 * `loopDormant` is broken out, not folded silently into `loop`: a dormant
 * loop is a suppression placeholder (001 §9 — quiets `reconcile` noise for
 * N-series background loops), not a real modeled behavior, so a reader
 * comparing this ratio across repos needs to see how much of the loop count
 * is "real" vs "just a placeholder that happens to carry an anchor".
 *
 * Counts nodes by iterating `graph.byKind.{loop,flow,junction}` (Map sizes),
 * NOT by pattern-matching `id:` occurrences in the YAML text — a junction's
 * nested `evidence[].id` entries are NOT junction nodes, and a naive text
 * scan would double-count them (a junction with 3 evidence entries recorded
 * as "4 junctions" instead of 1). This function counts parsed, deduplicated
 * graph nodes, so that mistake isn't representable here.
 */
export interface CoverageRatioStats {
  nodes: {
    loop: number;
    loopDormant: number;
    flow: number;
    junction: number;
    /** loop + flow + junction (loopDormant is a subset of loop, not added again). */
    total: number;
    /**
     * Nodes that actually carry a code anchor — the numerator that MEANS
     * something here.
     *
     * `total` counts every declared node, including ones with no anchor at
     * all. On the repo this was calibrated against, only 28 of 67 loops carry
     * anchors and none of the 9 flows do, so a `total`-based ratio is
     * dominated by nodes that touch no file and is not measuring the
     * compression of anything. The anchored count is what pairs with
     * `coveredFileCount`, because both sides are then talking about the same
     * files.
     */
    anchored: number;
  };
  /**
   * Whether each node carries the declarations that make it answerable —
   * 判据 C's OTHER half, and the half that does the real work.
   *
   * The ratio alone cannot tell healthy growth from gaming: adding anchors to
   * existing nodes (what this plan's next steps do) and stuffing one new node
   * per new file (the gaming it guards against) BOTH move the ratio toward
   * 1:1. What separates them is whether the nodes carry answerable content —
   * a real node states a boundary, is pinned to a scenario, declares its
   * mechanism; a stuffed one is empty. Report both, and let a human read them
   * together.
   */
  information: {
    /** Active (non-dormant) loops — the denominator for the loop shares below. */
    activeLoops: number;
    loopsWithScenario: number;
    loopsWithBoundary: number;
    loopsWithMechanism: number;
    junctionsWithScenario: number;
  };
  /** = coveredFiles(graph).size — same figure as `BacktestComputation.anchoredFileCount`,
   * computed independently here so this function has no dependency on the
   * commit-window computation (it needs only the graph, nothing git-related). */
  coveredFileCount: number;
  /**
   * nodes.anchored / coveredFileCount — THE ratio, or null when
   * coveredFileCount is 0 (undefined, not a fake 0 or Infinity, which does not
   * survive a JSON round-trip).
   */
  ratio: number | null;
  /**
   * nodes.total / coveredFileCount. Kept only because a declared-but-unanchored
   * node is still a thing someone wrote down; it is NOT the guard figure, for
   * the reason given on `nodes.anchored`.
   */
  ratioAllNodes: number | null;
}

export function computeCoverageRatio(graph: ModelGraph): CoverageRatioStats {
  const loops = [...graph.byKind.loop.values()];
  const flows = [...graph.byKind.flow.values()];
  const junctions = [...graph.byKind.junction.values()];
  const loopDormant = loops.filter((l) => l.dormant === true).length;
  const total = loops.length + flows.length + junctions.length;
  // Anchored = carries at least one code anchor. A dormant loop's anchor
  // counts: it really does register a file (that is the whole point of the
  // suppression channel), so excluding it would understate the numerator
  // against a `coveredFiles` denominator that DOES include it.
  const anchored =
    loops.filter((l) => l.anchors.length > 0).length +
    flows.filter((f) => f.anchors.length > 0).length +
    junctions.filter((j) => j.evidence.length > 0).length;
  const activeLoops = loops.filter((l) => l.dormant !== true);
  const coveredFileCount = coveredFiles(graph).size;
  return {
    nodes: {
      loop: loops.length,
      loopDormant,
      flow: flows.length,
      junction: junctions.length,
      total,
      anchored,
    },
    information: {
      activeLoops: activeLoops.length,
      loopsWithScenario: activeLoops.filter((l) => l.scenarios.length > 0).length,
      loopsWithBoundary: activeLoops.filter((l) => l.boundary.trim().length > 0).length,
      loopsWithMechanism: activeLoops.filter((l) => (l.mechanism?.length ?? 0) > 0).length,
      junctionsWithScenario: junctions.filter((j) => j.scenarios.length > 0).length,
    },
    coveredFileCount,
    ratio: coveredFileCount === 0 ? null : anchored / coveredFileCount,
    ratioAllNodes: coveredFileCount === 0 ? null : total / coveredFileCount,
  };
}

/** `n/total` as a rounded percentage, or "n/a" when total is 0 (never divide-by-zero into a fake "0%"). */
export function pct(n: number, total: number): string {
  if (total === 0) return "n/a";
  return `${Math.round((n / total) * 100)}%`;
}

export interface BacktestReport extends BacktestComputation {
  ref: string;
  windowRequested: number;
  /** raw commits walked (>= overall.total) to collect the window — see collectBacktestCommits. */
  commitsScanned: number;
  /** true when the scan hit its internal cap before the window filled — see collectBacktestCommits. */
  scanCapped: boolean;
  componentsDeclared: boolean;
}

/** Short, human-readable rendering of a `ModelRef` — `@ <8-char sha>` (+ " dirty"
 * if uncommitted changes), or a plain-English fallback outside a git checkout. */
export function formatModelRef(ref: ModelRef): string {
  if (!ref.head) return "model: not a git checkout / no commits yet";
  return `model @ ${ref.head.slice(0, 8)}${ref.dirty ? " dirty" : ""}`;
}

/**
 * Plain-text report, one fact per line. Mirrors `formatCoverage`'s shape
 * (headline, then a breakdown) but reports the COMMIT-side number — don't
 * confuse with `codeontic coverage`'s MODEL-side one, hence the distinct
 * command name and the "backtest" prefix on every line here.
 */
export function formatBacktest(report: BacktestReport, modelRef: ModelRef): string[] {
  const lines: string[] = [];
  lines.push(
    `backtest @ ${report.ref} [${formatModelRef(modelRef)}]: ${report.anchoredFileCount} model-anchored file(s), ` +
      `scanned ${report.commitsScanned} commit(s) to collect ${report.overall.total}/${report.windowRequested} window`,
  );
  // Counting method, stated once here rather than left for a reader to
  // rediscover by diffing numbers: `anchoredFileCount` comes from parsing
  // every anchor in the model YAML, not from a `grep '"[^"]+\.tsx?#'` scan —
  // an unquoted YAML anchor (a valid plain scalar) or a non-`.ts` evidence
  // anchor (a spec doc) is counted here but invisible to that grep, so this
  // number reading a few files higher than a hand-rolled grep is expected,
  // not a bug.
  lines.push(
    "  (counts parsed model anchors, not a quote-requiring grep — expect a few more than a naive `.tsx?#` text scan)",
  );
  if (report.overall.total < report.windowRequested) {
    lines.push(
      report.scanCapped
        ? `⚠ only found ${report.overall.total}/${report.windowRequested} qualifying commit(s) within the scan cap — history may hold more`
        : `⚠ only found ${report.overall.total}/${report.windowRequested} qualifying commit(s) — reached the start of history`,
    );
  }
  lines.push(
    `overall: ${report.overall.hit}/${report.overall.total} (${pct(report.overall.hit, report.overall.total)})`,
  );
  if (!report.componentsDeclared) {
    lines.push(
      "(no components declared — see .codeontic/config.json `components`; no partition breakdown)",
    );
  } else {
    lines.push(
      "  by role (rows can overlap — a commit touching two roles counts toward both, don't sum):",
    );
    for (const p of report.byRole) {
      lines.push(`    ${p.label}: ${p.hit}/${p.total} (${pct(p.hit, p.total)})`);
    }
    lines.push("  by component (rows can overlap, same reason):");
    for (const p of report.byComponent) {
      lines.push(`    ${p.label} (${p.id}): ${p.hit}/${p.total} (${pct(p.hit, p.total)})`);
    }
  }
  return lines;
}

/**
 * Plain-text report for 判据 C (see `computeCoverageRatio`'s doc for what
 * this measures and why). A separate formatter, not folded into
 * `formatBacktest`, because C is a property of the MODEL alone — it needs no
 * git history and stays reportable even when A's window collection fails
 * (bad ref, not a git checkout — see src/cli/commands/backtest.ts).
 */
export function formatCoverageRatio(stats: CoverageRatioStats): string[] {
  const { nodes, information: info } = stats;
  const ratioText = stats.ratio === null ? "n/a" : stats.ratio.toFixed(2);
  const allText = stats.ratioAllNodes === null ? "n/a" : stats.ratioAllNodes.toFixed(2);
  return [
    `judgement C: ${nodes.anchored} anchored node(s) ÷ ${stats.coveredFileCount} covered file(s) = ${ratioText}`,
    `  declared nodes: ${nodes.total} (${nodes.loop} loop [${nodes.loopDormant} dormant] / ${nodes.flow} flow / ${nodes.junction} junction) — all-node ratio ${allText}, reported for context only`,
    `  information per node: ${info.loopsWithBoundary}/${info.activeLoops} active loop(s) state a boundary, ${info.loopsWithScenario}/${info.activeLoops} pinned to a scenario, ${info.loopsWithMechanism}/${info.activeLoops} declare a mechanism; ${info.junctionsWithScenario}/${nodes.junction} junction(s) pinned to a scenario`,
    // Said plainly because the ratio invites a verdict it cannot support, and
    // a guard that fires on healthy work is a guard people learn to ignore
    // (the same argument unregistered.ts makes about advisory signals).
    "  read them together: the ratio alone cannot separate healthy growth from gaming — anchoring existing nodes and stuffing one node per file BOTH move it toward 1:1. What tells them apart is whether the nodes carry answerable content (the line above).",
  ];
}
