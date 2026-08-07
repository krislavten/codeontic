import type { ImplementationFact } from "../adapters/types.js";
import type { ModelGraph } from "../loader/model-graph.js";
import { anchorFilePath, anchorSymbol } from "./anchor.js";
import { type ReadRepoFile, resolveDelegation, symbolLineSpan } from "./delegation.js";

/**
 * C2 T1 reconciliation (Proposal 006 Phase 3): which extracted implementation
 * facts (pg-boss queues, setInterval pollers) are NOT registered by any model
 * node. This is the "unregistered route/queue/poller 拦截" check — B1 facts
 * reconciled against the model registry.
 *
 * ADVISORY (T1), not a T0 gate: it reports, it does not fail the build. The
 * enforcement-tier promotion (report → block) is C3, gated on a measured
 * false-positive rate on real target-repo PRs.
 */
/**
 * A reconciliation partitions every fact into exactly ONE of three disjoint
 * buckets — `registered + dormantSuppressed + unregistered === total`.
 * (Delegation-registered facts, below, are a SUBSET of `registered` — they do
 * not add a fourth bucket, they just widen how a fact earns its way into the
 * one it already had.)
 */
export interface Reconciliation {
  /**
   * facts whose file is covered by an ACTIVE model node (a real, modeled
   * loop/junction), OR whose line falls inside a one-hop delegation target
   * resolved from an active loop's anchor (see `delegationHits`).
   */
  registered: ImplementationFact[];
  /**
   * facts whose file is covered ONLY by a dormant Loop (an N-series
   * "baseline-only" registration) — NOT by any active node. A distinct bucket,
   * not a subset of `registered`: a dormant registration quiets the advisory
   * signal without being real modeling, so it is surfaced separately (001 §12
   * 不掩盖缺口 — the quieting must be visible, not hidden inside `registered`).
   */
  dormantSuppressed: ImplementationFact[];
  /** facts whose file no model node anchors — the advisory findings. */
  unregistered: ImplementationFact[];
  /** repo-relative files the model registers (active + dormant anchors), sorted. */
  coveredFiles: string[];
  /**
   * Queue names declared in some active loop's `consumes_queues` that matched NO
   * extracted fact — surfaced so a declaration can't silently fail to register
   * (and so the model stays honest as the code moves under it).
   */
  unmatchedConsumedQueues: UnmatchedConsumedQueue[];
  /**
   * One-hop delegation targets resolved from an ACTIVE loop's anchors while
   * reconciling (#23 PR3), and how many facts each one pulled into
   * `registered`. Always `[]` when `readFile` was not passed to
   * `reconcileFacts` — delegation is opt-in, see that function's doc.
   *
   * WHY THIS EXISTS, SEPARATELY FROM THE BUCKET COUNTS: a delegation hit and
   * a check that plain didn't run both leave `unregistered` unchanged from
   * the no-delegation baseline in the case that matters least (nothing to
   * find either way) — but they must NOT look the same in the case that
   * matters: a hop that resolved and found nothing vs. a hop that never got
   * attempted are different failure modes to debug. This field is the
   * "the tracer ran" tripwire the CLI prints, mirroring `checkLoopMechanism`'s
   * `severity: "info"` Violation for the identical reason.
   */
  delegationHits: DelegationHit[];
}

/**
 * One `Loop.anchors` entry that resolved to a one-hop delegation target
 * (`delegation.ts`), and how many facts that target's OWN symbol span pulled
 * into `registered`. `registeredFactCount` can be 0 — the hop resolved (the
 * wrapper really does hand off) but nothing in this batch of facts happened
 * to land in the target's span; that is still worth showing, it is not the
 * same thing as "delegation didn't run".
 */
export interface DelegationHit {
  /** the active loop whose anchor delegated. */
  loopId: string;
  /** the anchor (`file#symbol`) that delegated. */
  anchor: string;
  /** where it resolved to, as `file#symbol`. */
  target: string;
  /** facts inside the target's symbol span that this hop moved into `registered`. */
  registeredFactCount: number;
}

/**
 * A declared-but-unmatched queue, carrying the loops that declared it.
 *
 * The bare name alone reads as an accusation against the model, and that
 * reading is wrong about half the time: the name may be perfectly correct in
 * code the extractor never reached (unscanned file, unresolved cross-file
 * constant). Naming the declaring loops lets a reader jump straight to their
 * anchors and settle which of the two it is, instead of being steered toward
 * "fix the model" by default.
 */
export interface UnmatchedConsumedQueue {
  queue: string;
  /** ids of the active loops whose `consumes_queues` declared it, sorted. */
  declaredBy: string[];
}

/** File part of an anchor `FILE#SYMBOL` (or the whole string when there is no `#`). */
export function anchorFile(anchor: string): string {
  const hash = anchor.indexOf("#");
  return hash === -1 ? anchor : anchor.slice(0, hash);
}

/**
 * Files registered by ACTIVE model nodes (non-dormant loops + flow anchors +
 * all junction evidence). These represent real, modeled coverage. Junctions are
 * always "active" — a junction only exists when a real cross-loop risk was modeled.
 *
 * Flow anchors count the same as loop anchors: a flow-shaped repo (a CLI, a
 * one-shot pipeline) registers its code THROUGH flows, so leaving them out here
 * makes every flow-anchored file a false "unregistered" — an over-flag, which is
 * exactly what the `reconcileFacts` doc below refuses to do. Flows have no
 * `dormant` flag, so they are all active.
 */
function activeCoveredFiles(graph: ModelGraph): Set<string> {
  const files = new Set<string>();
  for (const loop of graph.byKind.loop.values())
    if (!loop.dormant) for (const a of loop.anchors) files.add(anchorFile(a));
  for (const flow of graph.byKind.flow.values())
    for (const a of flow.anchors) files.add(anchorFile(a));
  for (const j of graph.byKind.junction.values())
    for (const e of j.evidence) files.add(anchorFile(e.anchor));
  return files;
}

/** Files registered ONLY by dormant loops (N-series baseline-only registrations). */
function dormantCoveredFiles(graph: ModelGraph): Set<string> {
  const files = new Set<string>();
  for (const loop of graph.byKind.loop.values())
    if (loop.dormant) for (const a of loop.anchors) files.add(anchorFile(a));
  return files;
}

/**
 * pg-boss queue names declared as consumed by an ACTIVE loop (Loop.consumes_queues,
 * C2 root-fix). A queue fact whose name is here is registered-by-name — its
 * lifecycle loop is modeled even though its producer-registry definition file
 * carries no anchor. Dormant loops don't count (they're a suppression channel,
 * not real modeling — see `dormantSuppressed`).
 */
function activeConsumedQueues(graph: ModelGraph): Map<string, string[]> {
  const byQueue = new Map<string, string[]>();
  for (const loop of graph.byKind.loop.values()) {
    if (loop.dormant) continue;
    for (const q of loop.consumes_queues) {
      const declarers = byQueue.get(q) ?? [];
      declarers.push(loop.id);
      byQueue.set(q, declarers);
    }
  }
  return byQueue;
}

/**
 * The set of repo-relative files the model registers, via `Loop.anchors`,
 * `Flow.anchors` and `Junction` evidence anchors (active + dormant). Non-code
 * evidence anchors (spec/issue files) are folded in too — harmless, they simply
 * never match a code fact's `filePath`.
 */
export function coveredFiles(graph: ModelGraph): Set<string> {
  return new Set([...activeCoveredFiles(graph), ...dormantCoveredFiles(graph)]);
}

/**
 * A single resolved delegation target, at symbol granularity: not just
 * `target.filePath` but the 1-based line span `target.symbol` occupies in it.
 */
interface ResolvedDelegation {
  loopId: string;
  anchor: string;
  targetFile: string;
  targetSymbol: string;
  span: { start: number; end: number };
}

/**
 * One-hop delegation targets reachable from ACTIVE loops' anchors (`Loop.anchors`
 * only — `Flow.anchors` is out of scope for this pass, matching `mechanism.ts`;
 * junction evidence anchors aren't symbol-shaped declarations of "what drives
 * this" the way a loop anchor is, so they're not candidates for this either).
 *
 * Dormant loops are excluded on purpose: `dormantCoveredFiles` already treats a
 * dormant registration as a suppression channel, not real modeling (see the
 * module doc and `Reconciliation.dormantSuppressed`) — letting a dormant
 * anchor's delegation target promote facts into `registered` would grant it
 * reach it never earned directly, defeating the "quieting must stay visible"
 * rule (001 §12) one hop further out.
 */
function resolveLoopDelegations(graph: ModelGraph, readFile: ReadRepoFile): ResolvedDelegation[] {
  const results: ResolvedDelegation[] = [];
  for (const loop of graph.byKind.loop.values()) {
    if (loop.dormant) continue;
    for (const anchor of loop.anchors) {
      const file = anchorFilePath(anchor);
      const symbol = anchorSymbol(anchor);
      if (!file || !symbol) continue; // table-style anchor, or malformed — nothing to follow
      const content = readFile(file);
      if (content === null) continue;
      // `symbol.split(".")[0]`: an anchor symbol can be `Class.method`
      // (dotted), but `resolveDelegation` looks up a single declaration name
      // in the file — mirrors `mechanism.ts`'s identical handling of the same
      // anchor shape, kept consistent rather than reinvented here.
      const target = resolveDelegation(file, content, symbol.split(".")[0] ?? "", readFile);
      if (!target) continue;
      const targetSource = readFile(target.filePath);
      if (targetSource === null) continue;
      const span = symbolLineSpan(target.filePath, targetSource, target.symbol);
      if (!span) continue;
      results.push({
        loopId: loop.id,
        anchor,
        targetFile: target.filePath,
        targetSymbol: target.symbol,
        span,
      });
    }
  }
  return results;
}

/**
 * Reads a repo-relative file (required to follow delegation at all — without
 * it `reconcileFacts` cannot parse anything, so delegation is simply skipped),
 * and whether to actually follow it. `followDelegation` defaults to `true` but
 * only takes effect when `readFile` is also given; it exists mainly so the CLI
 * can offer `--no-follow-delegation` for a direct "with vs. without" comparison
 * without the caller having to omit `readFile` (which would also disable
 * `checkLoopMechanism`'s independent delegation following if the two ever
 * shared a call site).
 */
export interface ReconcileDelegationOptions {
  readFile?: ReadRepoFile;
  followDelegation?: boolean;
}

/**
 * Reconcile extracted facts against the model's registered anchors.
 *
 * FILE-LEVEL granularity is the BASE mechanism — a fact whose file carries ANY
 * loop/junction anchor counts as covered. That stays true and stays the ONLY
 * granularity for anchors themselves: the fact `name` is a queue string /
 * interval marker, a different namespace from the class/function symbols
 * anchors use, so symbol-level matching would need the extractor to also
 * capture each fact's enclosing symbol — future work, and if that granularity
 * is ever added for anchors this reconciliation must be revisited. File-level
 * deliberately UNDER-flags (a partially-modeled file hides an extra
 * unregistered loop it also contains) rather than over-flags: an advisory T1
 * signal that cries wolf gets ignored, so the bias is toward silence on
 * ambiguity (001 §12 "不掩盖缺口" is about not hiding KNOWN gaps, not about
 * manufacturing noisy ones).
 *
 * DELEGATION IS THE ONE EXCEPTION, AND IT IS SYMBOL-LEVEL ON PURPOSE (#23
 * PR3). When `readFile` is passed, a fact that lands inside a one-hop
 * delegation target's OWN symbol span also registers — but crediting the
 * whole target FILE, the way a direct anchor does, would be wrong here: an
 * anchor is a human's deliberate statement (file-level slack is a considered
 * trade-off, immediately above); a delegation target is the TOOL's inference,
 * and a service file typically holds several methods. Granting file-level
 * credit for an inferred hop would rebuild the exact false-green this whole
 * change removes, one hop further out (see delegation.ts's `symbolLineSpan`
 * doc, and `mechanism.ts`, which drew this same line first). Opt-in, and
 * doubly so: omit `readFile` and behaviour is byte-identical to before this
 * option existed (every pre-existing caller does exactly that); pass it but
 * set `followDelegation: false` and it is skipped anyway (the CLI's
 * `--no-follow-delegation`).
 *
 * N-series background loops (ttl-renewal, vault-refresh, ...) are suppressed by
 * registering them as minimal (dormant, owner-null) Loop nodes carrying an
 * anchor — that is where "baseline-only" N-loops live (001 §9), NOT in the debt
 * list (debt = dead-state-machines, a structurally different thing).
 */
export function reconcileFacts(
  facts: ImplementationFact[],
  graph: ModelGraph,
  nameMatchableSignalKinds: readonly string[] = [],
  delegationOptions: ReconcileDelegationOptions = {},
): Reconciliation {
  const active = activeCoveredFiles(graph);
  const dormant = dormantCoveredFiles(graph);
  const consumedQueues = activeConsumedQueues(graph);
  const nameMatchable = new Set(nameMatchableSignalKinds);
  const registered: ImplementationFact[] = [];
  const dormantSuppressed: ImplementationFact[] = [];
  const unregistered: ImplementationFact[] = [];

  const shouldFollowDelegation =
    delegationOptions.readFile !== undefined && (delegationOptions.followDelegation ?? true);
  const delegations = shouldFollowDelegation
    ? resolveLoopDelegations(graph, delegationOptions.readFile as ReadRepoFile)
    : [];
  // Grouped by target FILE so `delegationFor` below only scans the (usually
  // one or two) delegations that could possibly match a given fact, not every
  // delegation in the model. Grouping is a single pass that only ever
  // `.push()`es, so each per-file list keeps the SAME relative order its
  // members had in `delegations` — `delegationFor`'s `.find()` below
  // therefore picks the identical "first match" a plain
  // `delegations.find(...)` over the whole array would have (this only
  // matters when two delegations into the SAME file have overlapping spans,
  // an edge case that predates this grouping, not one it could introduce).
  const delegationsByFile = new Map<string, ResolvedDelegation[]>();
  for (const d of delegations) {
    const list = delegationsByFile.get(d.targetFile);
    if (list) list.push(d);
    else delegationsByFile.set(d.targetFile, [d]);
  }
  // `hitKey` — not the `ResolvedDelegation` object itself — is the Map key
  // for hit counts: object identity happens to be stable within one
  // `reconcileFacts` call today, but a string key doesn't rely on that
  // holding across any future refactor of this function. `.join(" ")`, not
  // bare concatenation: " " is a character none of loop id / anchor /
  // repo-relative file path / TS identifier can legally contain, so no
  // combination of the four values can collide into the same key.
  const hitKey = (d: ResolvedDelegation): string =>
    [d.loopId, d.anchor, d.targetFile, d.targetSymbol].join(" ");
  const delegationHitCounts = new Map<string, number>();
  const delegationFor = (f: ImplementationFact): ResolvedDelegation | undefined =>
    (delegationsByFile.get(f.filePath) ?? []).find(
      (d) => f.line >= d.span.start && f.line <= d.span.end,
    );

  // Four-way DISJOINT partitioning of every fact (active-direct wins over
  // active-via-delegation wins over dormant wins over nothing) — but that is
  // an internal detail: publicly `registered`, `dormantSuppressed`, and
  // `unregistered` still partition every fact, delegation just widens the
  // FIRST of the three (see `Reconciliation.registered` doc). EVERY fact —
  // any adapter, any signal kind — reconciles by FILE first (the base
  // mechanism): file anchored → registered. The extra `consumes_queues`
  // name-match is an OPT-IN, declared by the ADAPTER via
  // `Adapter.nameMatchableSignalKinds` (Proposal 010 §2 item 4 — generalized
  // from an earlier hardcoded `pg_boss_queue` check; a queue-backed target's
  // adapter declares `["pg_boss_queue"]` for its producer/consumer file
  // split). Signal kinds NOT in that set are NOT ignored — they just
  // reconcile by file only.
  // The engine here stays opaque to what any adapter's signal kinds even mean.
  const isActive = (f: ImplementationFact): boolean =>
    active.has(f.filePath) || (nameMatchable.has(f.signal) && consumedQueues.has(f.name));

  for (const f of facts) {
    if (isActive(f)) {
      registered.push(f);
      continue;
    }
    const delegation = delegationFor(f);
    if (delegation) {
      registered.push(f);
      const key = hitKey(delegation);
      delegationHitCounts.set(key, (delegationHitCounts.get(key) ?? 0) + 1);
      continue;
    }
    if (dormant.has(f.filePath)) {
      dormantSuppressed.push(f); // covered only by a dormant N-loop — quieted, reported apart
    } else {
      unregistered.push(f);
    }
  }
  // A declared consumed-queue name that matched no fact of a name-matchable
  // signal kind is reported so it can't silently rot. Deliberately NOT called a
  // typo here: extraction reaching the name is a precondition for matching it,
  // so an unmatched name means either the model is wrong OR the extractor never
  // got to the code — the caller is given `declaredBy` to tell them apart.
  const factQueueNames = new Set(
    facts.filter((f) => nameMatchable.has(f.signal)).map((f) => f.name),
  );
  const unmatchedConsumedQueues: UnmatchedConsumedQueue[] = [...consumedQueues.entries()]
    .filter(([q]) => !factQueueNames.has(q))
    .map(([queue, declaredBy]) => ({ queue, declaredBy: [...declaredBy].sort() }))
    .sort((a, b) => a.queue.localeCompare(b.queue));

  // Reported for every RESOLVED hop, including a `registeredFactCount: 0` one
  // — see `DelegationHit` doc for why "resolved but empty" must stay visible
  // rather than being filtered out here.
  const delegationHits: DelegationHit[] = delegations.map((d) => ({
    loopId: d.loopId,
    anchor: d.anchor,
    target: `${d.targetFile}#${d.targetSymbol}`,
    registeredFactCount: delegationHitCounts.get(hitKey(d)) ?? 0,
  }));

  return {
    registered,
    dormantSuppressed,
    unregistered,
    coveredFiles: [...new Set([...active, ...dormant])].sort(),
    unmatchedConsumedQueues,
    delegationHits,
  };
}
