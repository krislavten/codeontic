import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Adapter, ImplementationFact, SignalKind } from "../../adapters/types.js";
import { loadComponents } from "../../config/components.js";
import { runFacts } from "../../facts/runner.js";
import { loadModel } from "../../loader/load-model.js";
import { type CoverageRatioStats, computeCoverageRatio, pct } from "../../query/backtest.js";
import { type Inv1CheckResult, runInv1Check } from "../../validate/inv1/check.js";
import { loadInv1Config } from "../../validate/inv1/config.js";
import { runT0 } from "../../validate/t0.js";
import type { T0Result } from "../../validate/types.js";
import { type TopologyModel, computeTopologyModel } from "../../views/topology-html.js";
import { type BacktestResult, DEFAULT_BACKTEST_WINDOW, runBacktest } from "./backtest.js";

const execFileAsync = promisify(execFile);

/**
 * Bumped 1 → 2 when `backtest`(判据 A) and `coverageRatio`(判据 C) were added
 * as REQUIRED Snapshot fields. `loadSnapshot` rejects anything whose
 * `schemaVersion` doesn't match — so a v1 artifact written by an
 * already-published version now correctly falls through to "no readable
 * prior snapshot" instead of being accepted and then crashing `diffSnapshots`
 * on `prev.backtest.ran` (v1 objects have no `backtest` key at all).
 *
 * Bumped 2 → 3 when `topologyEdges` (issue #23 阶段2 Q2, edge-granularity
 * topology drift) was added as a REQUIRED Snapshot field. Same rejection
 * contract as the 1→2 bump: a v2 artifact (no `topologyEdges` key at all)
 * correctly falls through to "no readable prior snapshot" instead of being
 * accepted and then handing `diffSnapshots` an `undefined.map` on
 * `prev.topologyEdges`.
 *
 * NOT bumped when issue #38 changed whether `topologyEdges` feeds `clean`
 * (see `SnapshotDrift.clean`'s doc) — that's a pure `diffSnapshots` behavior
 * change, not a `Snapshot` shape change. `topologyEdges` itself still has
 * the exact same required, `TopologyEdgeDigest[] | null` shape a v3 reader
 * expects, so a v3 artifact written by the OLD `clean` semantics remains
 * fully readable and diffs identically under the NEW ones. `SnapshotDrift`
 * (what changed) is never persisted — only `Snapshot` (what didn't) is.
 */
export const SNAPSHOT_SCHEMA_VERSION = 3 as const;

/**
 * A fact's stable identity for drift comparison. Deliberately DROPS the source
 * `line` — the extractor documents line as "not a stable anchor", so a cosmetic
 * line shift must NOT register as drift. `detail`/`unanalyzable` ARE compared:
 * a queue that becomes env-suffixed, or a name that goes unanalyzable, is a real
 * change worth surfacing.
 */
export interface FactDigest {
  signal: SignalKind;
  name: string;
  filePath: string;
  detail?: string;
  unanalyzable?: boolean;
}

/**
 * A topology edge's stable identity for drift comparison (issue #23 阶段2
 * Q2) — deliberately COARSER than `FactDigest`. `from` is a declared
 * component id (or the reserved unattributed-bucket id, see
 * `views/topology-html.ts`'s `UNATTRIBUTED_NODE_ID`) — never a raw
 * `filePath` — because the whole point of this grain is that a call site
 * moving between two files of the SAME component must not register as a
 * change. `to` is whatever the fact's `TopologyHint.to` named. `toKind` rides
 * along for display only (see `diffSnapshots`'s edge key — it is NOT part of
 * the comparison identity) and is present only when `to` resolved to an
 * EXTERNAL node with a known kind.
 */
export interface TopologyEdgeDigest {
  from: string;
  to: string;
  toKind?: string;
}

/**
 * The T2 nightly artifact (Proposal 006 D2). A machine-readable full-scan
 * snapshot: the facts inventory plus T0/INV-1 health, stamped with the adapter
 * version and the scanned commit. Two uses: (1) a PR job reads it as a warm
 * starting point instead of re-scanning from cold; (2) two snapshots diff into a
 * drift report. 001 §6 red line: T2 NEVER gates a PR — this command is
 * standalone and `check` never calls it.
 */
export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  /** The adapter that produced the facts — a bump here explains fact churn that isn't real drift. */
  adapterVersion: string;
  /** HEAD of the scanned repo when known (git rev-parse), else undefined. */
  commit?: string;
  /** ISO timestamp; injected so the artifact is reproducible in tests. */
  generatedAt: string;
  t0: { ok: boolean; errors: number; warnings: number };
  inv1: {
    ran: boolean;
    skippedReason?: string;
    violations: number;
    unanalyzable: number;
    writePoints: number;
  };
  /**
   * Sorted fact inventory (identity fields only — see FactDigest). EXCLUDES
   * topology-tagged facts (anything with `fact.topology !== undefined`,
   * e.g. `outbound_edge`/`dependency_client`) — those participate in drift at
   * EDGE granularity instead, via `topologyEdges` below, not here. Keeping
   * them in both places would double-count the same real-world change at two
   * granularities, and would let call-site-level noise (a call site's file
   * moving within its own component) leak back into `clean` through THIS
   * list even though `topologyEdges` correctly stays silent about it.
   */
  facts: FactDigest[];
  factCount: number;
  /**
   * Topology edges (issue #23 阶段2 Q2), collapsed to (from, to) identity —
   * see `TopologyEdgeDigest`'s doc for why this is a DISTINCT, coarser grain
   * from `facts` above rather than a replacement for it: a topology-tagged
   * fact is emitted ONE PER CALL SITE, so moving a `new OssClient()` from
   * file A to file B inside the same component is architecturally a no-op
   * but would be a removed-fact-plus-added-fact pair at fact granularity.
   * This list collapses that down to whether the (from, to) EDGE itself
   * appeared or disappeared — a genuinely new call target still registers,
   * a call site just moving house does not. Sorted by (from, to) — same
   * ordering `computeTopologyModel` (views/topology-html.ts) already
   * produces its edges in, reused here rather than re-derived (CONTRIBUTING:
   * 派生判断只定义一处).
   *
   * `null` means the edges could NOT BE COMPUTED (see
   * `topologyEdgesUnavailable`) — deliberately not `[]`, because "this target
   * genuinely has no edges" and "we failed to work out its edges" are opposite
   * facts and collapsing them makes the next run report every edge as removed.
   * config-file.ts states the same rule for the layer below: "'no config' is a
   * normal state, 'config you meant to write but broke' must never degrade
   * into it."
   */
  topologyEdges: TopologyEdgeDigest[] | null;
  /**
   * Why `topologyEdges` is `null`, in words. Present iff it is null.
   *
   * Carried IN the artifact, not just logged at write time: whoever reads a
   * drift report the next morning is usually not whoever broke the config,
   * and "edges unavailable" without a reason sends them looking for an
   * architecture change that never happened.
   */
  topologyEdgesUnavailable?: string;
  /**
   * 判据 A (issue #23 阶段1 PR1): commit-side backtest — of the last N
   * `.ts`/`.tsx`-touching commits, how many touched a model-anchored file.
   * Always present (never omitted) so a nightly consumer can tell "ran but
   * found nothing" apart from "field doesn't exist in this schema version" —
   * same convention as `inv1` above. `ran: false` when no repoRoot was given
   * (the snapshot is model-only) or the repo/ref couldn't be resolved.
   */
  backtest: BacktestSnapshotSummary;
  /**
   * 判据 C (issue #23 §1): node-to-covered-file ratio, the counterweight to A
   * — A can be inflated by declaring more anchors without real per-file
   * coverage ("灌节点"); C is the number that catches that. Deliberately a
   * TOP-LEVEL sibling of `backtest`, NOT nested inside it: C needs only the
   * model graph (no git at all), so it must survive exactly the failures
   * that make `backtest.ran` false (bad ref, no repoRoot, broken components
   * config) — nesting it inside `backtest` would silently lose C on precisely
   * the nights A's git-side plumbing has trouble, defeating "nightly watches
   * both judgements at once".
   */
  coverageRatio: CoverageRatioStats;
  timingMs: number;
}

export interface BacktestPartitionSummary {
  id: string;
  label: string;
  hit: number;
  total: number;
}

export interface BacktestSnapshotSummary {
  ran: boolean;
  skippedReason?: string;
  ref: string;
  windowRequested: number;
  commitsScanned: number;
  scanCapped: boolean;
  anchoredFileCount: number;
  overall: { hit: number; total: number };
  /** See BacktestComputation's doc (src/query/backtest.ts): rows can overlap,
   * don't sum them expecting `overall.total`. */
  byRole: BacktestPartitionSummary[];
  byComponent: BacktestPartitionSummary[];
  componentsDeclared: boolean;
}

export interface SnapshotDrift {
  /** true when the adapter version differs — fact changes below may be extractor churn, not real drift. */
  adapterBumped: boolean;
  addedFacts: FactDigest[];
  removedFacts: FactDigest[];
  /** same identity (signal+name+filePath), different detail/unanalyzable. */
  changedFacts: { before: FactDigest; after: FactDigest }[];
  /**
   * EDGE-granularity topology drift (issue #23 阶段2 Q2) — a STRUCTURAL peer
   * of `addedFacts`/`removedFacts` above (same shape: two arrays of "what
   * changed"), but NOT a `clean` peer — see `clean`'s doc for why issue #38
   * pulled edges back out of `clean` six hours after PR #40 had put them in.
   * See `Snapshot.topologyEdges`'s doc for why edges are a separate
   * granularity from `facts` at all. Identity is (from, to) only — see
   * `diffSnapshots`'s edge key — so a `toKind` classification improving
   * between two snapshots for the SAME (from, to) pair is not itself
   * surfaced here as an add+remove.
   *
   * MACHINE-READABLE CONSUMPTION CONTRACT (issue #38 §3 — target-repo
   * PR-side delivery; NOT YET WIRED into either this repo's CLI or any
   * target repo's CI, tracked as two separate open follow-ups):
   *   A PR job wanting "which edges did THIS PR add" needs two `Snapshot`s
   *   — a base one for the PR's merge-base commit and a current one for the
   *   PR head — and computes `diffSnapshots(base, current).addedEdges`.
   *   Each element is a plain `{ from, to, toKind? }` object (see
   *   `TopologyEdgeDigest`), directly `JSON.stringify`-able for a PR-comment
   *   payload — no additional serialization step is needed. Two gaps stand
   *   between that and a working target-repo integration:
   *     1. (this repo, open) `codeontic snapshot --drift` today only prints
   *        `renderDrift`'s prose to stdout (see run.ts's `snapshot` case) —
   *        there is no flag that emits `SnapshotDrift` itself as JSON, the
   *        way `codeontic backtest --json` already does for its own report.
   *        `package.json` also has no `main`/`exports`, only `bin` — a PR
   *        job cannot `import` this module directly today, so a CLI flag
   *        (not a library import) is the realistic path.
   *     2. (target repo, open) obtaining the BASE snapshot for a PR's
   *        merge-base commit — nightly already writes one to `actions/cache`
   *        per this issue's own accounting, so a PR job would restore that
   *        cache entry (or otherwise produce a base snapshot) before it can
   *        call `diffSnapshots`. How that CI wiring happens is entirely the
   *        target repo's call and out of this repo's scope.
   */
  addedEdges: TopologyEdgeDigest[];
  removedEdges: TopologyEdgeDigest[];
  /**
   * Set when the edge comparison was SKIPPED because one side's edges could
   * not be computed (see `Snapshot.topologyEdges`). While set, `addedEdges`
   * and `removedEdges` are empty because nothing was compared — NOT because
   * nothing changed. This has no bearing on `clean` either way (issue #38:
   * `clean` ignores edges unconditionally now, skipped or not — see that
   * field's doc) — but `renderDrift` still always prints this reason so a
   * broken config never silently reads as "edges checked, nothing changed".
   */
  edgesSkippedReason?: string;
  t0Delta: { errors: number; warnings: number };
  /**
   * INV-1 deltas. `unanalyzable` matters as much as `violations`: a write point
   * the canonical-writer scan can no longer analyze is a real loss of coverage,
   * not a no-op — it must not report as "no drift".
   */
  inv1Delta: { violations: number; unanalyzable: number };
  /**
   * 判据 A hit/total before and after, when BOTH snapshots ran a backtest.
   * Deliberately EXCLUDED from `clean` below (see that field's doc) — the
   * trailing-N-commit window shifts on every run (new commits enter, old ones
   * roll off), so treating any hit/total change as "drift" would make `clean`
   * false almost every single night and defeat the whole point of a
   * quiet-on-no-change signal. `renderDrift` still always surfaces it, the
   * same way `adapterBumped` is surfaced without affecting `clean`.
   */
  backtestDelta?: { hitBefore: number; totalBefore: number; hitAfter: number; totalAfter: number };
  /**
   * 判据 C deltas (node counts + covered-file count, before/after — see
   * `computeCoverageRatio`). UNLIKE `backtestDelta`, this DOES feed `clean`
   * below: it changes only when the MODEL itself changes (nodes added/
   * removed, anchors added/removed), never as a side effect of which commits
   * happen to fall in tonight's trailing window — so a change here is real
   * target drift, exactly the kind `clean` exists to catch (a t0Delta/
   * inv1Delta peer, not a backtestDelta peer). Compared as raw integer counts,
   * not the derived `ratio` float — the ratio is what a reader looks at, but
   * the counts are what actually changed and what a robust equality check
   * should compare. `nodesAnchored` (not just `nodesTotal`) is tracked
   * because it's the ratio's actual numerator post-correction — anchoring an
   * EXISTING node (nodesTotal unchanged) is exactly the healthy move this
   * plan's next steps make, and it must register as drift even though
   * `nodesTotal` alone wouldn't catch it.
   */
  coverageRatioDelta: {
    nodesTotalBefore: number;
    nodesTotalAfter: number;
    nodesAnchoredBefore: number;
    nodesAnchoredAfter: number;
    coveredFileCountBefore: number;
    coveredFileCountAfter: number;
  };
  /**
   * true when nothing MODEL-side changed (facts, T0, INV-1, 判据 C
   * node/covered-file counts). An adapter version bump alone does NOT make
   * it dirty (it's a tooling change, not target drift) — and neither does a
   * backtest window shift, see `backtestDelta`, nor a topology edge
   * appearing/disappearing, see `addedEdges`/`removedEdges` — but
   * `renderDrift` still surfaces all three so none is ever hidden.
   *
   * General rule (issue #38): a fact that can change for a reason OTHER
   * than the model actually drifting does not feed `clean` — it gets its
   * own always-visible group in `renderDrift` instead, so it stays fully
   * reportable without being able to devalue the one signal `clean` exists
   * to protect. Three instances of this judgment call exist so far:
   *   - `backtestDelta`: EXCLUDED. The trailing-N-commit window shifts on
   *     every run regardless of the target, so treating any shift as drift
   *     would make `clean` false almost every night (see that field's doc).
   *   - `coverageRatioDelta`: INCLUDED. It moves only when the model itself
   *     changes (nodes/anchors added or removed) — never as a side effect
   *     of which commits happen to fall in tonight's window — so it IS real
   *     target drift (see that field's doc).
   *   - `addedEdges`/`removedEdges`: EXCLUDED (issue #38, reversing the
   *     edge-into-`clean` design PR #40 shipped roughly six hours earlier).
   *     A new outbound call target is normal, expected development
   *     activity — one that recurs on essentially every feature PR that
   *     starts talking to something new — not "something that shouldn't
   *     have happened". Folding it into `clean` makes `clean` false on
   *     ordinary weeks, which defeats the whole point of a quiet-on-no-
   *     change signal exactly the way `reconcile` mixing topology facts
   *     into its unregistered-count once did (unregistered count 6 → 69,
   *     real signal drowned out, fixed by introducing
   *     `reconcilableSignalKinds`) — this is that same failure mode's
   *     second instance. Edge changes are NOT hidden by this exclusion:
   *     `renderDrift` always prints them in their own group regardless of
   *     `clean`, and the target-repo PR-side delivery (issue #38 §3, not
   *     yet wired — see `SnapshotDrift.addedEdges`'s doc) is meant to be
   *     where they get a claimable, same-day reader instead of a nightly
   *     one.
   *
   * `SnapshotDrift` (this type) is never persisted — only `Snapshot` is
   * (see `writeSnapshot`) — so this is a pure behavior change with no
   * `SNAPSHOT_SCHEMA_VERSION` bump: a `Snapshot` artifact written before
   * this change diffs identically after it, because `topologyEdges`'s shape
   * never changed — only how `diffSnapshots` scores it into `clean` did.
   *
   * SCOPE CAVEAT (pre-existing, restated here because removing edges makes
   * this verdict the headline): `clean` compares implementation facts, T0 /
   * INV-1 counts and the judgement-C aggregates. It is NOT a model-graph
   * equivalence check — no stable digest of node identities or relations is
   * stored, so an edit that keeps every count identical (repointing a Flow
   * `traverses` from one loop to another, say) still reads `clean: true`.
   * Read it as "none of the tracked signals moved", not "the model did not
   * change". Closing that gap needs a model digest in `Snapshot` and a schema
   * bump — deliberately out of scope for issue #38, tracked separately.
   */
  clean: boolean;
}

/** Stable identity key for a fact digest (drift comparison). */
function factKey(f: FactDigest): string {
  return `${f.signal} ${f.name} ${f.filePath}`;
}

function digestOf(fact: ImplementationFact): FactDigest {
  const d: FactDigest = { signal: fact.signal, name: fact.name, filePath: fact.filePath };
  if (fact.detail !== undefined) d.detail = fact.detail;
  if (fact.unanalyzable !== undefined) d.unanalyzable = fact.unanalyzable;
  return d;
}

/** True when two digests with the same identity carry a different value (detail/unanalyzable). */
function valueChanged(a: FactDigest, b: FactDigest): boolean {
  return a.detail !== b.detail || Boolean(a.unanalyzable) !== Boolean(b.unanalyzable);
}

/**
 * Stable identity key for a topology edge digest (drift comparison) —
 * (from, to) ONLY. `toKind` deliberately does not participate: it is display
 * metadata about the target node (see `TopologyEdgeDigest`'s doc), and an
 * adapter refining its classification of an already-known target must not
 * read as the edge itself appearing/disappearing.
 */
function edgeKey(e: TopologyEdgeDigest): string {
  return JSON.stringify([e.from, e.to]);
}

/**
 * Reduces a `TopologyModel` (views/topology-html.ts's `computeTopologyModel`
 * — REUSED here, not reimplemented, per CONTRIBUTING's 派生判断只定义一处)
 * down to the `topologyEdges` drift identity. Drops `count`/`evidence`:
 * those are CALL-SITE-granularity counters, and comparing them would readmit
 * exactly the noise edge-granularity drift exists to kill — one more call
 * into an ALREADY-connected target is more traffic through an existing
 * architectural edge, not a new one. `toKind` is read off the TARGET NODE,
 * not the raw fact, so it always agrees with whatever the topology view
 * itself would label that node.
 */
function topologyEdgeDigests(model: TopologyModel): TopologyEdgeDigest[] {
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const digests = model.edges.map((e) => {
    const target = nodeById.get(e.target);
    const toKind = target?.kind === "external" ? target.toKind : undefined;
    return { from: e.source, to: e.target, ...(toKind !== undefined ? { toKind } : {}) };
  });
  // `computeTopologyModel` already returns `edges` sorted by (source, target)
  // AND deduplicated (its `edges` Map is keyed by `(source, target)`, with
  // repeat call sites accumulating into ONE entry's `count` rather than
  // producing more entries — see that function's `edges.set(key, edge)` /
  // `edge.count++`). Sorting again here is belt-and-suspenders, not new
  // logic: it keeps `topologyEdges`'s ordering an explicit,
  // locally-verifiable guarantee of THIS function rather than an inherited
  // assumption about a function it merely calls.
  return digests.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** All-zero 判据 C reading — the default when a caller doesn't pass one
 * (existing pre-C call sites), so `Snapshot.coverageRatio` is still always a
 * real, well-typed object rather than needing to be optional. */
const ZERO_COVERAGE_RATIO: CoverageRatioStats = {
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
};

/**
 * Assemble a Snapshot from already-run scan results. PURE — all non-determinism
 * (commit, timestamp, adapter version) is passed in, so it is fully unit-testable.
 */
export function buildSnapshot(
  meta: {
    adapterVersion: string;
    commit?: string | undefined;
    generatedAt: string;
    timingMs: number;
  },
  t0: T0Result,
  facts: ImplementationFact[],
  inv1: Inv1CheckResult | undefined,
  backtest?: BacktestResult | undefined,
  coverageRatio: CoverageRatioStats = ZERO_COVERAGE_RATIO,
  /**
   * Undefined when no topology model could be built. Pair it with
   * `topologyEdgesUnavailable` to say WHY: absent-because-nothing-to-compute
   * (no repo-root/adapter) is a normal empty result, while
   * absent-because-something-broke must be recorded as unavailable, never as
   * an empty edge list (see `Snapshot.topologyEdges`).
   */
  topologyModel?: TopologyModel | undefined,
  /** Set only when edges could not be computed; makes `topologyEdges` null. */
  topologyEdgesUnavailable?: string | undefined,
): Snapshot {
  // topology-tagged facts participate in drift at EDGE granularity via
  // `topologyEdges` below, not here — see `Snapshot.facts`'s doc. Filtered
  // BEFORE `digestOf` so `FactDigest` itself never has to know `topology`
  // exists.
  const digests = facts
    .filter((f) => f.topology === undefined)
    .map(digestOf)
    .sort((a, b) => factKey(a).localeCompare(factKey(b)));
  // `null` (not `[]`) ONLY when something broke — see the field's doc. A run
  // with nothing to compute (no repo-root/adapter) still reports `[]`: that is
  // a real "no edges", not a failure, and must stay distinguishable from one.
  const topologyEdges =
    topologyEdgesUnavailable !== undefined
      ? null
      : topologyModel
        ? topologyEdgeDigests(topologyModel)
        : [];
  const inv1Summary = inv1
    ? {
        ran: inv1.ran,
        ...(inv1.skippedReason ? { skippedReason: inv1.skippedReason } : {}),
        violations: inv1.writePoints.filter((w) => w.verdict === "violation").length,
        unanalyzable: inv1.writePoints.filter((w) => w.verdict === "unanalyzable").length,
        writePoints: inv1.writePoints.length,
      }
    : {
        ran: false,
        skippedReason: "INV-1 not run (no repo-root or config)",
        violations: 0,
        unanalyzable: 0,
        writePoints: 0,
      };
  const backtestSummary: BacktestSnapshotSummary =
    backtest?.ran === true
      ? {
          ran: true,
          ref: backtest.report.ref,
          windowRequested: backtest.report.windowRequested,
          commitsScanned: backtest.report.commitsScanned,
          scanCapped: backtest.report.scanCapped,
          anchoredFileCount: backtest.report.anchoredFileCount,
          overall: backtest.report.overall,
          byRole: backtest.report.byRole,
          byComponent: backtest.report.byComponent,
          componentsDeclared: backtest.report.componentsDeclared,
        }
      : {
          ran: false,
          skippedReason: backtest?.skippedReason ?? "backtest not run (no repo-root)",
          ref: "HEAD",
          windowRequested: DEFAULT_BACKTEST_WINDOW,
          commitsScanned: 0,
          scanCapped: false,
          anchoredFileCount: 0,
          overall: { hit: 0, total: 0 },
          byRole: [],
          byComponent: [],
          componentsDeclared: false,
        };
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    adapterVersion: meta.adapterVersion,
    ...(meta.commit ? { commit: meta.commit } : {}),
    generatedAt: meta.generatedAt,
    t0: {
      ok: t0.ok,
      errors: t0.violations.filter((v) => v.severity === "error").length,
      warnings: t0.violations.filter((v) => v.severity === "warning").length,
    },
    inv1: inv1Summary,
    facts: digests,
    factCount: digests.length,
    topologyEdges,
    ...(topologyEdgesUnavailable !== undefined ? { topologyEdgesUnavailable } : {}),
    backtest: backtestSummary,
    coverageRatio,
    timingMs: meta.timingMs,
  };
}

/**
 * Diff two snapshots into a drift report. PURE. Compares the fact inventory by
 * stable identity (added/removed/value-changed), the topology edge set by
 * (from, to) identity, and the T0/INV-1 counts.
 */
export function diffSnapshots(prev: Snapshot, curr: Snapshot): SnapshotDrift {
  const prevByKey = new Map(prev.facts.map((f) => [factKey(f), f]));
  const currByKey = new Map(curr.facts.map((f) => [factKey(f), f]));

  const addedFacts = curr.facts.filter((f) => !prevByKey.has(factKey(f)));
  const removedFacts = prev.facts.filter((f) => !currByKey.has(factKey(f)));
  const changedFacts: { before: FactDigest; after: FactDigest }[] = [];
  for (const [key, before] of prevByKey) {
    const after = currByKey.get(key);
    if (after && valueChanged(before, after)) changedFacts.push({ before, after });
  }

  // EDGE-granularity topology drift (issue #23 阶段2 Q2) — independent of the
  // fact-granularity comparison above, see Snapshot.topologyEdges's doc.
  //
  // SKIPPED, not "everything removed", when either side's edges are
  // unavailable. Diffing a real edge set against a failed one would report the
  // entire architecture as deleted — a finding that is both false and alarming,
  // and whose real cause (usually a config typo) appears nowhere in the output.
  // `edgesSkippedReason` carries that cause into the report instead.
  //
  // Structured as one branch rather than "derive a skip reason, then guard
  // every use with `?? []`": that shape leaves a fallback sitting on a path it
  // can never legally reach, so the day the skip derivation drifts out of sync
  // with the null checks, an unavailable edge set silently becomes an empty one
  // and this exact bug is back. Here the comparison simply cannot be reached
  // with a null on either side.
  let edgesSkippedReason: string | undefined;
  let addedEdges: TopologyEdgeDigest[] = [];
  let removedEdges: TopologyEdgeDigest[] = [];
  if (prev.topologyEdges === null) {
    edgesSkippedReason = `previous snapshot: ${prev.topologyEdgesUnavailable ?? "topology edges unavailable"}`;
  } else if (curr.topologyEdges === null) {
    edgesSkippedReason = `current snapshot: ${curr.topologyEdgesUnavailable ?? "topology edges unavailable"}`;
  } else {
    const prevEdgeByKey = new Map(prev.topologyEdges.map((e) => [edgeKey(e), e]));
    const currEdgeByKey = new Map(curr.topologyEdges.map((e) => [edgeKey(e), e]));
    addedEdges = curr.topologyEdges.filter((e) => !prevEdgeByKey.has(edgeKey(e)));
    removedEdges = prev.topologyEdges.filter((e) => !currEdgeByKey.has(edgeKey(e)));
  }

  const t0Delta = {
    errors: curr.t0.errors - prev.t0.errors,
    warnings: curr.t0.warnings - prev.t0.warnings,
  };
  const inv1Delta = {
    violations: curr.inv1.violations - prev.inv1.violations,
    unanalyzable: curr.inv1.unanalyzable - prev.inv1.unanalyzable,
  };
  const coverageRatioDelta = {
    nodesTotalBefore: prev.coverageRatio.nodes.total,
    nodesTotalAfter: curr.coverageRatio.nodes.total,
    nodesAnchoredBefore: prev.coverageRatio.nodes.anchored,
    nodesAnchoredAfter: curr.coverageRatio.nodes.anchored,
    coveredFileCountBefore: prev.coverageRatio.coveredFileCount,
    coveredFileCountAfter: curr.coverageRatio.coveredFileCount,
  };
  const clean =
    addedFacts.length === 0 &&
    removedFacts.length === 0 &&
    changedFacts.length === 0 &&
    t0Delta.errors === 0 &&
    t0Delta.warnings === 0 &&
    inv1Delta.violations === 0 &&
    inv1Delta.unanalyzable === 0 &&
    // See SnapshotDrift.coverageRatioDelta's doc: unlike backtestDelta, C
    // counts as real target drift — compared as the raw integers, not the
    // derived float ratio.
    coverageRatioDelta.nodesTotalBefore === coverageRatioDelta.nodesTotalAfter &&
    coverageRatioDelta.nodesAnchoredBefore === coverageRatioDelta.nodesAnchoredAfter &&
    coverageRatioDelta.coveredFileCountBefore === coverageRatioDelta.coveredFileCountAfter;
  // `clean` deliberately does NOT factor in backtestDelta (see
  // SnapshotDrift.backtestDelta's doc) or addedEdges/removedEdges (issue
  // #38 — see the `clean` field's own doc for the general rule and all
  // three instances of this judgment call made so far).
  const backtestDelta =
    prev.backtest.ran && curr.backtest.ran
      ? {
          hitBefore: prev.backtest.overall.hit,
          totalBefore: prev.backtest.overall.total,
          hitAfter: curr.backtest.overall.hit,
          totalAfter: curr.backtest.overall.total,
        }
      : undefined;

  return {
    adapterBumped: prev.adapterVersion !== curr.adapterVersion,
    addedFacts,
    removedFacts,
    changedFacts,
    addedEdges,
    removedEdges,
    ...(edgesSkippedReason ? { edgesSkippedReason } : {}),
    t0Delta,
    inv1Delta,
    ...(backtestDelta ? { backtestDelta } : {}),
    coverageRatioDelta,
    clean,
  };
}

export interface SnapshotOptions {
  repoRoot?: string | undefined;
  /** Machine cache dir for facts (B3); null disables. Default: the shared cache. */
  cacheDir?: string | null | undefined;
  /** The adapter supplying the facts (Proposal 010: no default — undefined means no facts). */
  adapter?: Adapter | undefined;
  /** Injected for reproducibility; defaults to now. */
  generatedAt?: string | undefined;
  /** Injected for tests; defaults to `git rev-parse HEAD` of repoRoot. */
  commit?: string | undefined;
}

/** Best-effort HEAD sha of a repo (undefined outside a git checkout). */
async function headCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a full T2 scan and build the snapshot (Proposal 006 D2): T0 over the
 * model, facts over the repo (which also WARMS the machine cache — the whole
 * point of the nightly run), and a full INV-1 pass. Returns the snapshot; the
 * CLI persists it. Never called from the PR-gate `check` path (001 §6).
 */
export async function runSnapshot(
  targetDir: string,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const start = performance.now();
  const model = await loadModel(join(targetDir, ".codeontic", "model"));
  const t0 = await runT0(model, {});
  // 判据 C needs only the parsed graph — computed unconditionally (unlike
  // facts/inv1/backtest below, all gated on `options.repoRoot`) so it's
  // present on a model-only snapshot too. See Snapshot.coverageRatio's doc
  // for why this is a top-level field, not nested inside `backtest`.
  const coverageRatio = computeCoverageRatio(model.graph);

  // Proposal 010: no adapter ships with this engine — the caller resolves one
  // (via --adapter-path or the .codeontic/adapter/ convention, see run.ts) and
  // passes it in. No adapter → "unknown" version, zero facts, INV-1 still runs
  // if a repo-root + config are present (INV-1 is adapter-independent).
  const adapterVersion = options.adapter?.version ?? "unknown";

  let facts: ImplementationFact[] = [];
  let inv1: Inv1CheckResult | undefined;
  let backtest: BacktestResult | undefined;
  let commit = options.commit;
  let topologyEdgesUnavailable: string | undefined;

  if (!options.repoRoot) {
    // The most root of the causes: nothing was scanned at all. Stated here, on
    // the snapshot, so every consumer reads ONE authoritative reason instead of
    // re-deriving it — two places inferring the same thing from different
    // inputs is how they end up disagreeing.
    topologyEdgesUnavailable =
      "no --repo-root: the repo was never scanned, so an empty edge set means 'not checked', not 'none found'";
  }

  if (options.repoRoot) {
    if (!options.adapter) {
      // The FIFTH cause of an empty edge list, and the one the four before it
      // left open: no adapter at all. The whole fact-extraction branch below is
      // skipped, `topologyEdgesUnavailable` is never set, and zero facts become
      // `topologyEdges: []` — indistinguishable from "scanned, found none". A
      // repo without an adapter would then get "no service-call edges were
      // added or removed" on every single PR: a reading that never ran, phrased
      // as a result.
      topologyEdgesUnavailable =
        "no adapter: fact extraction never ran (an adapter is what knows how to read this repo)";
    }
    if (options.adapter) {
      // exactOptionalPropertyTypes: only pass cacheDir when the caller set it
      // (undefined = "use the default machine cache", which runFacts handles).
      const factsResult = await runFacts(options.repoRoot, {
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        adapter: options.adapter,
      });
      facts = factsResult.facts;
      // issue #48 — the FOURTH cause of an empty edge list. The adapter
      // resolved and a repo root was given, but the scan itself did not run
      // (a `git grep -E` the adapter's pattern is illegal for, an unreadable
      // checkout). `runFacts` reports that honestly as `ran: false` with zero
      // facts, and everything downstream then treats those zero facts as an
      // observation: `topologyEdges: []`, `comparable: true`, and a PR comment
      // saying "no service-call edges were added or removed" — a signal lying
      // about its own cause, the exact failure #46 made the edge status fields
      // REQUIRED to prevent. It missed this cause; this closes it. Same
      // treatment as an unreadable components config below, for the same
      // reason: absent-because-something-broke is never an empty edge list.
      if (!factsResult.ran) {
        topologyEdgesUnavailable = `fact extraction did not run: ${
          factsResult.skippedReason ?? "no reason reported"
        }`;
      }
    }
    if (commit === undefined) commit = await headCommit(options.repoRoot);

    const configResult = await loadInv1Config(targetDir);
    if (configResult.config) {
      inv1 = await runInv1Check(options.repoRoot, configResult.config, {});
    }

    // 判据 A needs neither an adapter nor facts — just git history + the
    // model's own anchors — so it runs whenever a repoRoot is given, even in
    // "no adapter" mode where facts/inv1 above are skipped.
    //
    // Caught explicitly (unlike the runFacts/runInv1Check calls above): this
    // is the newest of the three data sources this function assembles, and
    // an unforeseen failure in it (a pathological git history, an OOM on a
    // huge log) must not take the whole nightly snapshot down with it — the
    // T0/facts/INV-1 data already gathered above is real and worth keeping.
    // buildSnapshot already has a `ran: false` shape for exactly this case.
    try {
      backtest = await runBacktest(targetDir, { repoRoot: options.repoRoot });
    } catch (err) {
      backtest = {
        ran: false,
        skippedReason: `backtest threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 拓扑边（issue #23 阶段2 Q2）: reuse the SAME edge-aggregation logic the
  // `topology` command uses (commands/topology.ts → views/topology-html.ts's
  // `computeTopologyModel`) rather than re-deriving `componentOf`/edge
  // bucketing here — CONTRIBUTING's 派生判断只定义一处. `facts` is whatever
  // was assembled above (`[]` when there's no repoRoot/adapter), so this is
  // safe to run unconditionally.
  //
  // Wrapped in try/catch — same "a downstream data source hiccup must not
  // crash the whole nightly run" posture as the backtest block above.
  // `loadComponents` is documented to never throw on a malformed
  // `.codeontic/config.json` (it returns `{ error }`, see
  // config/components.ts) and `computeTopologyModel` is a pure function over
  // already-validated inputs, so this is belt-and-suspenders rather than a
  // known failure mode — but the same "must not take the rest of the
  // snapshot down" guarantee the backtest block makes explicit is worth
  // making explicit here too, not left as an unstated assumption about a
  // contract two other modules happen to uphold today.
  //
  // A components-config ERROR does NOT degrade to zero edges. Every fact's
  // `from` is resolved through the declared components, so pretending an
  // unreadable config is an empty one re-homes all of them and the next diff
  // reports the whole architecture as removed — measured on a real target, one
  // typo (`frontend` → `frontEnd`) turned 36 edges into 9 and produced 43 edge
  // changes, with nothing anywhere saying the cause was a config typo. That is
  // a signal lying about its own cause, which is worse than a silent one: it
  // sends a reader hunting for an architecture change that never happened.
  // The `topology` command stays the place that shouts about a bad config;
  // this call site's job is merely to not fabricate edges from one.
  let topologyModel: TopologyModel | undefined;
  try {
    const { components, error } = await loadComponents(targetDir);
    if (topologyEdgesUnavailable !== undefined) {
      // The fact scan already failed (issue #48, above) — edges derived from
      // zero facts would be a fabrication, so leave the reason standing.
    } else if (error !== undefined) {
      topologyEdgesUnavailable = `components config could not be read: ${error}`;
    } else {
      topologyModel = computeTopologyModel(
        facts,
        components ?? [],
        options.repoRoot !== undefined && options.adapter !== undefined,
      );
    }
  } catch (err) {
    topologyEdgesUnavailable = `topology edges could not be computed: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return buildSnapshot(
    { adapterVersion, commit, generatedAt, timingMs: performance.now() - start },
    t0,
    facts,
    inv1,
    backtest,
    coverageRatio,
    topologyModel,
    topologyEdgesUnavailable,
  );
}

/** Load a previously-written snapshot (for drift comparison). undefined if absent/unreadable. */
export async function loadSnapshot(path: string): Promise<Snapshot | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Snapshot;
    if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** One-line human summary of a snapshot's health. */
export function renderSnapshotSummary(s: Snapshot): string {
  const c = s.commit ? ` @ ${s.commit.slice(0, 8)}` : "";
  const inv1 = s.inv1.ran
    ? `INV-1 ${s.inv1.violations} violation(s) / ${s.inv1.unanalyzable} unanalyzable`
    : "INV-1 skipped";
  const backtest = s.backtest.ran
    ? `backtest ${s.backtest.overall.hit}/${s.backtest.overall.total} (${pct(s.backtest.overall.hit, s.backtest.overall.total)})`
    : "backtest skipped";
  // `ratio === null` only when `coveredFileCount === 0` (see
  // computeCoverageRatio's doc) — "N/0=n/a" reads as a botched division, so
  // that case gets its own short form instead of the count/count=ratio shape.
  // The numerator shown MUST be the one the ratio is actually computed from —
  // `nodes.anchored`, not `nodes.total`. Printing the total beside an
  // anchored-derived ratio produced a line that contradicted itself
  // ("C 82/40=0.85", when 82/40 is 2.05). That is worse than showing no ratio
  // at all: a reader who does the division, gets a different answer, and
  // cannot tell which half is wrong stops trusting the whole summary line.
  const coverageRatio =
    s.coverageRatio.ratio === null
      ? `C ${s.coverageRatio.nodes.anchored} anchored node(s), n/a`
      : `C ${s.coverageRatio.nodes.anchored}/${s.coverageRatio.coveredFileCount}=${s.coverageRatio.ratio.toFixed(2)}`;
  return (
    `snapshot${c} [${s.adapterVersion}]: ${s.factCount} fact(s), ` +
    `T0 ${s.t0.ok ? "ok" : `${s.t0.errors} error(s)`} (${s.t0.warnings} warning(s)), ${inv1}, ${backtest}, ${coverageRatio}, ${s.timingMs.toFixed(0)}ms`
  );
}

const signed = (n: number): string => `${n > 0 ? "+" : ""}${n}`;

/** Human drift report between two snapshots (Proposal 006 D2). */
export function renderDrift(drift: SnapshotDrift): string[] {
  const lines: string[] = [];
  // Emitted FIRST and unconditionally: an adapter bump alone leaves `clean` true
  // (it's tooling, not target drift), but the reader must still be told the
  // extractor changed — so it's never swallowed by the clean case below.
  if (drift.adapterBumped)
    lines.push(
      "⚠ adapter version changed — fact changes below may be extractor churn, not real drift",
    );

  // Same "always surfaced, never gated behind `clean`" treatment as
  // adapterBumped above, and for the same reason: `clean` intentionally
  // excludes this (see SnapshotDrift.backtestDelta), so if it were only
  // rendered inside the non-clean branch below, a night where NOTHING else
  // changed would silently hide a real backtest coverage swing.
  if (drift.backtestDelta) {
    const { hitBefore, totalBefore, hitAfter, totalAfter } = drift.backtestDelta;
    if (hitBefore !== hitAfter || totalBefore !== totalAfter) {
      lines.push(
        `backtest: ${hitBefore}/${totalBefore} (${pct(hitBefore, totalBefore)}) → ` +
          `${hitAfter}/${totalAfter} (${pct(hitAfter, totalAfter)})`,
      );
    }
  }

  // Topology edges (issue #38) — OWN group, ALWAYS surfaced regardless of
  // `clean`: never gated behind the clean/dirty branch below, and never
  // folded into the fact-drift lines further down. See `clean`'s doc for
  // why edges were pulled back out of `clean`, and `SnapshotDrift.addedEdges`'s
  // doc for the machine-readable contract a PR job is meant to read this
  // exact same data through. The header names this group as the current
  // SOLE place an edge change is visible (issue #38 §4) — until the PR-side
  // delivery lands, this group is where a reader finds out about a new or
  // removed edge at all, so that dependency is stated explicitly rather
  // than left implicit.
  const edgesChanged = drift.addedEdges.length > 0 || drift.removedEdges.length > 0;
  if (edgesChanged) {
    lines.push(
      "topology edges (does not affect `clean` — currently the ONLY place edge changes are visible; see issue #38):",
    );
    for (const e of drift.addedEdges)
      lines.push(`+ edge ${e.from} → ${e.to}${e.toKind ? ` (${e.toKind})` : ""}`);
    for (const e of drift.removedEdges)
      lines.push(`- edge ${e.from} → ${e.to}${e.toKind ? ` (${e.toKind})` : ""}`);
  }

  // Printed BEFORE the clean/dirty verdict and on BOTH paths: a skipped edge
  // comparison must never be readable as "edges checked, nothing changed".
  // That is the whole failure this field exists to prevent.
  if (drift.edgesSkippedReason) {
    lines.push(`⚠ edge comparison SKIPPED — ${drift.edgesSkippedReason}`);
  }

  if (drift.clean) {
    // The verdict NAMES every non-model axis that moved instead of appending
    // them to a branch that already claimed exclusivity: "only the adapter
    // version changed" followed by "topology edges DID change" is a line that
    // contradicts itself, which is precisely the "a signal misreports its own
    // cause" failure this command keeps having to fix. `clean` stays a
    // MODEL-side verdict (facts, T0, INV-1, judgement C); the adapter version
    // and edges are reported ALONGSIDE it, never folded into it.
    const edgesNote = edgesChanged
      ? " (topology edges DID change — see the group above; excluded from this verdict by design, see `clean`'s doc)"
      : "";
    lines.push(
      (drift.edgesSkippedReason
        ? "no drift in what COULD be compared (facts, T0, INV-1, judgement C) — edges not compared, see above"
        : // "ONLY the adapter version changed" is an exclusivity claim, so it
          // must not be reachable while edges also changed: appending the note
          // to it produces a line that contradicts itself, and contradicts the
          // edge group printed just above. The other two wordings scope
          // themselves to the four named axes, so the note completes them
          // rather than fighting them.
          drift.adapterBumped && !edgesChanged
          ? "no target drift (only the adapter version changed)"
          : drift.adapterBumped
            ? "no model-side drift (facts, T0, INV-1, judgement C all unchanged); the adapter version changed too"
            : "no drift (facts, T0, INV-1, and judgement C all unchanged)") + edgesNote,
    );
    return lines;
  }

  for (const f of drift.addedFacts) lines.push(`+ fact ${f.signal} ${f.name}  ${f.filePath}`);
  for (const f of drift.removedFacts) lines.push(`- fact ${f.signal} ${f.name}  ${f.filePath}`);
  for (const { before, after } of drift.changedFacts)
    lines.push(
      `~ fact ${after.signal} ${after.name}  ${after.filePath}: ${before.detail ?? "-"} → ${after.detail ?? "-"}`,
    );
  if (drift.t0Delta.errors !== 0) lines.push(`T0 errors ${signed(drift.t0Delta.errors)}`);
  if (drift.t0Delta.warnings !== 0) lines.push(`T0 warnings ${signed(drift.t0Delta.warnings)}`);
  if (drift.inv1Delta.violations !== 0)
    lines.push(`INV-1 violations ${signed(drift.inv1Delta.violations)}`);
  if (drift.inv1Delta.unanalyzable !== 0)
    lines.push(`INV-1 unanalyzable ${signed(drift.inv1Delta.unanalyzable)}`);
  // Judgement C — a t0Delta/inv1Delta peer (feeds `clean`), so rendered in
  // this same non-clean branch, not the always-shown backtestDelta style
  // above. Each line is a NET delta, same convention as t0Delta/inv1Delta
  // above: a node removed and a different one added in the same window nets
  // to 0 and prints nothing here, even though something did change. `clean`
  // itself isn't fooled by this (it already went false via whichever OTHER
  // count moved), so this is a display nuance, not a correctness gap.
  const nodesDelta =
    drift.coverageRatioDelta.nodesTotalAfter - drift.coverageRatioDelta.nodesTotalBefore;
  if (nodesDelta !== 0) lines.push(`judgement C nodes ${signed(nodesDelta)}`);
  const anchoredDelta =
    drift.coverageRatioDelta.nodesAnchoredAfter - drift.coverageRatioDelta.nodesAnchoredBefore;
  if (anchoredDelta !== 0) lines.push(`judgement C anchored nodes ${signed(anchoredDelta)}`);
  const coveredDelta =
    drift.coverageRatioDelta.coveredFileCountAfter -
    drift.coverageRatioDelta.coveredFileCountBefore;
  if (coveredDelta !== 0) lines.push(`judgement C covered file(s) ${signed(coveredDelta)}`);
  return lines;
}

/** Persist a snapshot as pretty JSON, atomically (temp file + rename). */
export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
