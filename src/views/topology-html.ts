import type { ImplementationFact } from "../adapters/types.js";
import type { Component, ComponentRole } from "../config/components.js";
import { componentLabel, componentOf } from "../config/components.js";

/**
 * `codeontic topology`: a self-contained HTML architecture diagram rendered
 * PURELY from `components` config (declared, § config/components.ts) + facts
 * carrying a `topology` hint (§ adapters/types.ts `TopologyHint`) — issue #23
 * P0. Deliberately the ONLY signal source: this view adds no model node kind
 * and reads no `.codeontic/model/` file, so it needs none of the decisions
 * the behavioral model requires and can ship before any of them are made.
 *
 * "Draw the picture before building the model" is the point (see the issue's
 * own framing): if this page gets looked at and answers real questions, that
 * is the evidence a topology DIMENSION belongs in the model later. If it
 * doesn't get used, nothing here cost a schema change to undo.
 *
 * Same posture as `graph`/`overview`: projection into the gitignored
 * `.codeontic/ws/` side-channel, PURE compute (`computeTopologyModel`) +
 * PURE render (`renderTopologyHtml`), zero external hosts in the output.
 */

// ─── model ──────────────────────────────────────────────────────────────

export type TopologyNode =
  | { id: string; label: string; kind: "component"; role: ComponentRole }
  // `toKind` is whatever the fact's TopologyHint said (adapter-invented
  // vocabulary — see that type's doc comment); absent when a fact pointed at
  // an external id without one.
  //
  // `observedOnly` is set ONLY by `computeTopologyEdgeDiff` (never by
  // `computeTopologyModel` below) for an id an observed-edges file names that
  // the static extractor never touched at all — see that function's doc for
  // why this is a degrade, not a drop. A plain topology render (no
  // --compare-edges) never produces a node carrying this flag.
  | { id: string; label: string; kind: "external"; toKind?: string; observedOnly?: true }
  // Exactly one of these, present only when at least one topology-tagged
  // fact's file matched no declared component. A bucket, not a real unit —
  // see the module doc comment: silently dropping those facts would hide
  // exactly the kind of config gap this command exists to surface.
  | { id: string; label: string; kind: "unattributed" };

export interface TopologyEdgeEvidence {
  filePath: string;
  line: number;
}

export interface TopologyEdge {
  source: string;
  target: string;
  /** How many topology-tagged facts collapsed into this (source, target) pair. */
  count: number;
  /** A capped sample of file:line sites — see EVIDENCE_CAP. Not exhaustive by design. */
  evidence: TopologyEdgeEvidence[];
}

export interface TopologyModel {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Count of topology-tagged facts whose file matched no declared component. */
  unattributedCount: number;
  /** false when facts extraction did not run at all (no --repo-root) — nodes-only render. */
  factsRan: boolean;
  summary: { components: number; external: number; edges: number };
}

/** Node id for the "file matched no declared component" bucket. Not a real component id. */
export const UNATTRIBUTED_NODE_ID = "(unattributed)";

/** Cap on evidence file:line sites kept per edge — an edge with 400 hits doesn't need 400 rows in the page. */
const EVIDENCE_CAP = 5;

const ROLE_RANK: Readonly<Record<ComponentRole, number>> = {
  frontend: 0,
  api: 1,
  worker: 2,
  sandbox: 3,
  library: 4,
};

/** Deterministic node ordering: role groups in a fixed, meaningful order, external next, unattributed always last. */
function nodeRank(n: TopologyNode): number {
  if (n.kind === "component") return ROLE_RANK[n.role];
  if (n.kind === "external") return 5;
  return 6; // unattributed
}

function nodeSort(a: TopologyNode, b: TopologyNode): number {
  return nodeRank(a) - nodeRank(b) || a.id.localeCompare(b.id);
}

/**
 * PURE. Builds the render model from declared components + a fact list.
 *
 * Node set = every declared component (so an isolated component with zero
 * edges still appears — the graph is "here is the org chart", not "here is
 * only what we found calls") + every DISTINCT external id a topology-tagged
 * fact points `to` that isn't already a component id + the unattributed
 * bucket, iff used.
 *
 * `from` is derived HERE via `componentOf`, never read off the fact — see the
 * module doc comment on `TopologyHint`: the adapter names its target, the
 * engine (which alone holds the component declarations) names the source.
 * A fact with no `topology` field is simply skipped (adapters that predate
 * this hint, or facts unrelated to topology, draw no edge — not an error).
 */
export function computeTopologyModel(
  facts: readonly ImplementationFact[],
  components: readonly Component[],
  factsRan: boolean,
): TopologyModel {
  const nodes = new Map<string, TopologyNode>();
  for (const c of components) {
    nodes.set(c.id, { id: c.id, label: componentLabel(c), kind: "component", role: c.role });
  }

  const edges = new Map<string, TopologyEdge>();
  let unattributedCount = 0;

  // Sort BEFORE processing, not after: `runFacts` already returns a stable
  // order, but this function is documented PURE and is also called directly
  // in tests with hand-built fact arrays — an evidence sample capped at
  // EVIDENCE_CAP must not depend on the caller happening to hand facts in a
  // particular order. Sorting once up front makes node/edge/evidence order
  // (and thus the whole render) deterministic regardless of input order.
  const sortedFacts = [...facts].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line,
  );

  for (const fact of sortedFacts) {
    const hint = fact.topology;
    if (!hint) continue;
    // A fact pointing `to` the reserved unattributed-bucket id is adapter
    // misbehavior (that id names a bookkeeping bucket, not a real
    // component/dependency) — treated as an invalid hint and skipped, rather
    // than letting it silently masquerade as either a real external node or
    // corrupt the bucket's own kind (see the dedicated regression test).
    if (hint.to === UNATTRIBUTED_NODE_ID) continue;

    // `to` MATCHING an already-declared component id draws an INTERNAL edge
    // into that component — this is not a special case, just what "already
    // in `nodes`" means. Only a `to` the components config never mentioned
    // creates a new "external" node here.
    if (!nodes.has(hint.to)) {
      nodes.set(hint.to, {
        id: hint.to,
        label: hint.to,
        kind: "external",
        ...(hint.toKind !== undefined ? { toKind: hint.toKind } : {}),
      });
    }

    const owner = componentOf(components, fact.filePath);
    const source = owner ? owner.id : UNATTRIBUTED_NODE_ID;
    if (!owner) {
      unattributedCount++;
      if (!nodes.has(UNATTRIBUTED_NODE_ID)) {
        nodes.set(UNATTRIBUTED_NODE_ID, {
          id: UNATTRIBUTED_NODE_ID,
          label: "unattributed files",
          kind: "unattributed",
        });
      }
    }

    // JSON-encoded pair, not a delimited string: a plain "-separator-" join
    // is exactly the class of bug this fixes -- if `source` or `hint.to` ever
    // contained the separator itself, two distinct edges would collide into
    // one. JSON.stringify of a 2-tuple has no such ambiguity regardless of
    // what characters a component/dependency id contains.
    const key = JSON.stringify([source, hint.to]);
    let edge = edges.get(key);
    if (!edge) {
      edge = { source, target: hint.to, count: 0, evidence: [] };
      edges.set(key, edge);
    }
    edge.count++;
    if (edge.evidence.length < EVIDENCE_CAP) {
      edge.evidence.push({ filePath: fact.filePath, line: fact.line });
    }
  }

  const nodeList = [...nodes.values()].sort(nodeSort);
  const edgeList = [...edges.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );

  return {
    nodes: nodeList,
    edges: edgeList,
    unattributedCount,
    factsRan,
    summary: {
      components: nodeList.filter((n) => n.kind === "component").length,
      external: nodeList.filter((n) => n.kind === "external").length,
      edges: edgeList.length,
    },
  };
}

// ─── edge diff (issue #23 §4's "第四条对账",阶段3 PR8) ─────────────────────
//
// The plan's own防腐 rule: a topology dimension only stays trustworthy if it
// diffs against something that CAN'T rot silently — either a real extractor
// or a drift check against runtime reality. This is that drift check.
//
// Deliberately diffs the EXTRACTOR's own edges (`TopologyModel.edges`,
// already computed above from facts) against a caller-supplied "what actually
// got called at runtime" list — NOT a hand-authored model edge declaration.
// The issue's original plan (PR7) would have added a second, HAND-MAINTAINED
// edge list to the behavioral model for this to diff against; that is
// exactly the kind of thing every other check in this engine (anchors, INV-1,
// fact reconciliation) exists to catch elsewhere — a declaration nobody is
// forced to keep in sync with the code. Skipping it and diffing the
// extractor's own output instead means EITHER side of this diff regenerates
// itself from the target repo; nothing here can go stale by omission. Whether
// a hand-authored edge concept (PR7) is worth adding at all is a decision
// THIS diff's own `staticCoverage` number is meant to inform, not something
// this PR pre-empts by building the hand-authored side first.
//
// The engine has zero opinion on where the observed-edges file comes from
// (OTel trace export, a service-mesh log, hand collection — see
// `cli/commands/topology.ts`'s `loadObservedEdges` doc) — same
// engine/adapter separation this whole command already follows for facts.

/**
 * `unobservable` is a bucket, not a footnote on `static-only` — see the
 * module doc's "possibly-unobservable" section for the incident that forced
 * this split (real trace showed 0 overlap; the actual cause was that
 * `agent-worker`/`pod-agent`'s OTLP exporter can't reach the collector at
 * all, not that those 6 edges are dead). Folding it into `static-only`'s
 * existing "dead path, or an observation gap" hedge was the exact failure
 * this whole engine exists to catch elsewhere: **a signal misreporting its
 * own cause**. A reader who sees "static-only" is entitled to read it as "we
 * looked and it wasn't there"; an edge this engine never had a chance of
 * observing must say so instead of quietly borrowing that same bucket.
 *
 * `queue-mediated` is a SEPARATE bucket from `observed-only`, added for the
 * same "don't misreport the cause" reason, for a DIFFERENT root cause: real
 * trace data from a target repo showed two of its services talking to each
 * other only via a queue (a producer's span parenting a `kind=consumer`
 * receive span on the other side, never a direct call). Pairing a queue's
 * producer and consumer into
 * one logical A→B edge was the ORIGINAL plan here — abandoned on
 * investigation: the consumer side is typically `deps.boss.work(deps.
 * queueName, handler)`, an indirect call the static extractor cannot resolve
 * to a literal queue name, and pairing by same-queue-NAME instead would
 * fabricate an edge between any two components that happen to touch a queue
 * with that name, including ones that never actually talk to each other.
 * So: no pairing, and no attempt to compare these against a static edge at
 * all — the observed side's own `viaQueue`/`kind === "consumer"` signal is
 * definitive and puts the pair straight into this bucket, never through the
 * confirmed/static-only/unobservable/observed-only classification below.
 * Excluded from `staticCoverage`'s denominator for a DIFFERENT reason than
 * `unobservable`: not "can't see it", but "can't safely say what static edge
 * it would even correspond to" — see `TopologyEdgeDiffSummary.staticCoverage`.
 */
export type EdgeDiffCategory =
  | "confirmed"
  | "static-only"
  | "observed-only"
  | "unobservable"
  | "queue-mediated";

export interface TopologyEdgeDiffEdge {
  source: string;
  target: string;
  category: EdgeDiffCategory;
  /**
   * `static | observed | both` — deliberately named `origin`, not `source`:
   * this interface already uses `source`/`target` for the edge's endpoint
   * ids, so reusing that name for "which side(s) produced this edge" would
   * collide with them. Purely DERIVED from `category` (never independently
   * computed) — `both` for confirmed, `static` for static-only|unobservable,
   * `observed` for observed-only|queue-mediated. `category` carries the
   * detailed WHY; `origin` is the coarse, symmetric "static and observed are
   * two co-equal fact sources" tag the pivot to this shape asked for — see
   * the module's top doc comment. Present on every edge unconditionally
   * (unlike the optional fields below), because every edge has exactly one.
   */
  origin: "static" | "observed" | "both";
  /** The extractor's own fact count for this pair — present iff category is confirmed|static-only|unobservable. */
  staticCount?: number;
  /** Same evidence sample the underlying TopologyEdge carries — present iff category is confirmed|static-only|unobservable. */
  evidence?: TopologyEdgeEvidence[];
  /** Total row occurrences of this pair in the observed-edges file — e.g. 3 if the same (from, to) pair appears in 3 rows, not just whether it appeared at all — present iff category is confirmed|observed-only|queue-mediated. */
  observedCount?: number;
  /**
   * Only set when category === "observed-only": whether BOTH endpoints were
   * already known to the static side (a declared component, or an id a
   * static fact already named as a target) before this observed edge came
   * along. `true` → a real gap between two known units — the extractor
   * missed a call between things it already knows exist (fix: extend/re-
   * check the adapter's extraction). `false` → at least one endpoint is
   * something static's own vocabulary never mentioned at all — a whole
   * dependency the static side never modeled (fix: that is a config/
   * declaration gap, not an extraction gap — the real trace data this bucket
   * was designed for surfaced several external config/auth services this
   * way, none of which were in the target repo's static model at all).
   * Keeping these two cases distinguishable is deliberate, not an
   * afterthought — see the module doc.
   */
  observedOnlyKnownEndpoints?: boolean;
  /**
   * Only set when category === "queue-mediated": best-effort, NON-
   * authoritative corroboration that BOTH endpoints ALSO have their own
   * static edge toward a queue-kind node (`toKind === "queue"`) — i.e. the
   * static side independently shows both sides "do something with a queue",
   * even though it cannot prove it is the SAME queue or the same hop. This
   * NEVER drives classification (only the observed row's own `viaQueue`/
   * `kind === "consumer"` does — see the category's own doc). Its absence
   * must read as "static didn't independently corroborate it" (the
   * extractor may simply not have resolved a dynamic queue name), never as
   * "this pairing is wrong" — the field is deliberately a hedge, not a
   * verdict.
   */
  queueStaticEvidence?: boolean;
  /**
   * Only set when category === "unobservable": WHICH side of the
   * observability check failed — real trace data surfaced a case the
   * original source-only check couldn't distinguish. `"source"` — the
   * edge's source component isn't in `observableComponents` (the original,
   * PR44 reason). `"target-kind"` — the source WAS in scope, but the
   * target is an external dependency of a kind this observation method
   * cannot see at all regardless of source telemetry health (e.g. a direct
   * DB/queue connection never produces an HTTP client span to trace — see
   * `TopologyEdgeDiffOptions.observableTargetKinds`'s doc for the concrete
   * incident: `postgres`/`redis` edges from a perfectly-observable source
   * were being read as "maybe dead" when the real reason was "this
   * observation method structurally cannot see a non-HTTP call, no matter
   * how alive it is" — the same signal-lying-about-its-own-cause failure as
   * the original `unobservable` split, just on the other endpoint).
   * `"both"` — neither side qualifies. These stay ONE bucket (not a new
   * category) per the module's "reasons, not buckets" rule — see the
   * `unobservable` field's own doc on `TopologyEdgeDiffSummary`.
   */
  unobservableReason?: "source" | "target-kind" | "both";
}

export interface TopologyEdgeDiffSummary {
  confirmed: number;
  /**
   * Edges with NO observed counterpart whose source IS in the declared
   * observable scope — see `unobservable` below for the complementary case.
   * This count is the actual "maybe dead, maybe untested" signal; it no
   * longer includes anything this engine couldn't have seen regardless.
   */
  staticOnly: number;
  /**
   * Observed pairs with no static counterpart, EXCLUDING queue-mediated ones
   * (those are `queueMediated` below, never this). See each edge's own
   * `observedOnlyKnownEndpoints` for the further split this count itself
   * does not carry: "a real gap between two known units" vs "static's
   * vocabulary never mentioned this dependency at all".
   */
  observedOnly: number;
  /**
   * Edges with no observed counterpart that fail EITHER observability check
   * — source not in `observableComponents`, OR target an external kind not
   * in `observableTargetKinds` (see that option's doc for the incident that
   * added the second axis: a `postgres`/`redis` edge from a perfectly-
   * observable source was still unconfirmable, because no HTTP-span-based
   * observation method can ever see a direct DB connection). Deliberately
   * excluded from `staticOnly`: a reader scanning that count for "how many
   * dead paths do I have" must not have it inflated by edges this engine
   * had zero chance of confirming either way regardless of cause. WHICH
   * axis failed for a given edge is on that edge's own `unobservableReason`
   * — this aggregate count intentionally does not split source-caused from
   * target-caused (see that field's doc for why the split lives at the
   * per-edge, not per-bucket, level). Excluded from `staticCoverage`'s
   * denominator — see that field's doc for why, and for how this differs
   * from `queueMediated`'s exclusion.
   */
  unobservable: number;
  /**
   * Observed pairs whose OWN evidence (`viaQueue`/`kind === "consumer"`)
   * says they were mediated by a queue, so no attempt was made to pair them
   * against a static edge at all — see the `"queue-mediated"` category's
   * doc on `EdgeDiffCategory` for why pairing was abandoned. Excluded from
   * `staticCoverage`'s denominator for a DIFFERENT reason than
   * `unobservable`: not "this engine couldn't see it", but "this engine
   * cannot safely say what static edge, if any, it corresponds to". The two
   * exclusions must never be merged into one vague "other" — see that
   * field's own doc.
   */
  queueMediated: number;
  /** DISTINCT observed pairs, regardless of category — a trace with the same call 500 times counts once here. No longer the coverage denominator (see `staticCoverage`) — kept as context for how much observed data participated at all. */
  observedTotal: number;
  /**
   * confirmed ÷ `staticCoverageDenominator` — THE number this feature exists
   * to produce (issue #23 §4). Deliberately NOT confirmed ÷ observedTotal
   * (PR8's original formula): that reading silently treats the OBSERVED side
   * as the baseline being graded against, which is exactly the asymmetry
   * this pivot exists to remove — static and observed are two co-equal fact
   * sources, each with its own blind spot (static can't see a runtime-
   * decided call; observed can't see anything whose telemetry never reaches
   * the collector, or a queue's other end). What this ratio actually answers
   * is narrower and honest about that: of the static edges that were even
   * ELIGIBLE for confirmation — comparable (not queue-mediated) AND
   * observable (not `unobservable`) — how many got one. `null` when the
   * denominator is 0, OR when the denominator is nonzero but too small to
   * support a meaningful percentage (below `MIN_COVERAGE_SAMPLE` inside
   * `computeTopologyEdgeDiff` — see `staticCoverageNaReason` for why) —
   * rather than defaulting to a 0%/100% that would misreport the cause. The
   * small-sample case is the SAME failure as the zero-denominator case, one
   * step later: `1/1 = 100%` reads exactly as authoritative as a real
   * sample would, even though a real incident showed it can be produced
   * purely by `observableTargetKinds` correctly shrinking the denominator
   * to just the confirmed edges — a reader screenshots "100% covered" and
   * the number lies about its own cause just as badly as the un-shrunk 5%
   * it replaced.
   */
  staticCoverage: number | null;
  /** `confirmed + staticOnly` — always present, even when `staticCoverage` is `null`, so a caller/renderer never has to recompute it to explain the n/a (and, for the small-sample case, so the raw counts can still be shown even though the percentage is withheld). */
  staticCoverageDenominator: number;
  /**
   * Set iff `staticCoverage` is `null` — WHY there was nothing to divide by
   * (or why what there was wasn't enough to divide meaningfully). Checked in
   * this order (the first that applies is reported):
   *  1. the static side produced no edges at all — nothing to compare full
   *     stop, not a coverage question;
   *  2. NEITHER `observableComponents` NOR `observableTargetKinds` was
   *     declared — both observability axes defaulted to "assume nothing is
   *     observable" (see each field's own doc);
   *  3. `observableComponents` was never declared (but `observableTargetKinds`
   *     was) — every static edge defaulted to unobservable on the source
   *     axis regardless of its target;
   *  4. `observableTargetKinds` was never declared (but `observableComponents`
   *     was) — every static edge whose target is an external dependency
   *     defaulted to unobservable on the target-kind axis;
   *  5. both scopes WERE declared, but happen not to cover any actual static
   *     edge (empty lists, or lists with no overlap) — everything still
   *     landed in `unobservable`;
   *  6. the denominator IS nonzero but smaller than `MIN_COVERAGE_SAMPLE` —
   *     a percentage would be technically computable but not meaningfully
   *     representative (see `staticCoverage`'s own doc for the incident
   *     this guards against). Distinct from 1-5: `staticCoverageDenominator`
   *     is nonzero here, so a renderer should show the raw counts, not a
   *     bare "n/a".
   * Never left for a reader to reverse-engineer from the other counts.
   */
  staticCoverageNaReason?: string;
  /**
   * Whether the caller supplied an explicit `observableComponents` list (even
   * an empty one) — see `computeTopologyEdgeDiff`'s doc for why an
   * UNDECLARED scope's honest default is "assume nothing is observable"
   * (every would-be static-only edge becomes `unobservable`) rather than
   * "assume everything is observable" (which is the exact mistake that
   * produced the false "0 overlap ⇒ nothing works" reading this bucket
   * exists to prevent). This flag is what lets the render layer tell a
   * reader WHICH default is in effect, instead of leaving `unobservable ===
   * staticOnly + unobservable` ambiguous between "I checked, none of this is
   * observable" and "nobody said".
   */
  observableScopeDeclared: boolean;
  /**
   * Same idea as `observableScopeDeclared`, for the OTHER observability axis
   * — see `TopologyEdgeDiffOptions.observableTargetKinds`'s doc for why a
   * second axis exists at all (a real incident: `postgres`/`redis` edges
   * from an in-scope source were still unconfirmable, because the
   * observation method structurally cannot see a non-HTTP call — that is a
   * TARGET-kind blind spot, not a source-telemetry one, and conflating the
   * two would have reproduced the exact "signal lying about its own cause"
   * failure this whole feature exists to catch).
   */
  targetKindsScopeDeclared: boolean;
  /**
   * Count of would-be static-only edges whose target is external but has NO
   * `toKind` at all, WHILE `observableTargetKinds` WAS declared AND the
   * edge's SOURCE is in `observableComponents` — i.e. edges where the
   * target-kind axis was the ONLY thing standing between this edge and
   * `static-only`, and it silently couldn't evaluate them. Distinct from
   * `!targetKindsScopeDeclared` (that means "nobody declared anything at
   * all"; this means "something WAS declared, but doesn't apply to every
   * edge because the adapter didn't tag all its targets"). The source-axis
   * precondition matters: an edge whose SOURCE is also out of scope is
   * `unobservable` regardless of whether its target ever gets a `toKind` —
   * the declared `observableTargetKinds` never had a chance to matter for
   * it either way, so counting it would inflate "your declaration didn't
   * reach these edges" with edges scope was never going to save in the
   * first place. Real risk this field catches: a caller declares
   * `observableTargetKinds` believing it now governs every external-target
   * edge whose source IS trustworthy, while some fraction of THOSE edges
   * keep getting classified purely on the SOURCE axis (see
   * `targetKindObservable`'s doc) with no visible sign that their scope
   * declaration didn't reach them — a silently narrower effect than
   * declared, the same class of failure as every other split in this
   * summary. Always computed (0 when nothing applies); a renderer should
   * only surface it as a warning when `targetKindsScopeDeclared` is true AND
   * this is nonzero — when the scope was never declared at all, the
   * existing `!targetKindsScopeDeclared` banner already covers it.
   */
  targetKindsUncheckable: number;
}

/** One target-name pair the engine noticed LOOK alike but never actually matched as the same node — see `TopologyEdgeDiff.nameSimilarityHints`'s doc. */
export interface NameSimilarityHint {
  /** An id that only ever showed up on the observed side (never in the static model). */
  observedId: string;
  /** An id the static side named that the observed side never confirmed. */
  staticId: string;
}

export interface TopologyEdgeDiff {
  /**
   * `model.nodes` PLUS a node for every id an observed edge names that isn't
   * already one — see `TopologyNode`'s `observedOnly` marker. This is the
   * "组件未声明" degrade: an observed pair naming an id nothing else in this
   * command has ever heard of is neither dropped (that would hide a real
   * extractor blind spot or a stale/typo'd id) nor mis-attributed as a real
   * declared component — it renders as its own honestly-labeled node.
   */
  nodes: TopologyNode[];
  edges: TopologyEdgeDiffEdge[];
  summary: TopologyEdgeDiffSummary;
  /**
   * A different id used on each side for what MIGHT be the same real
   * dependency — e.g. observed-only `"cache"` next to static-only
   * `"redis-cache"`. Real incident: the SAME dependency was being reported
   * as BOTH "a brand-new dependency we've never seen" (observed-only) AND "a
   * dead path" (static-only) purely because the adapter's static id and the
   * trace export's hostname-derived id disagree — the fifth instance of a
   * signal lying about its own cause in this feature's history. Deliberately
   * NOT auto-merged (see this array's computation for why: a hand-maintained
   * alias table is exactly the kind of thing this engine exists to avoid,
   * and a WRONG auto-merge would silently hide a real difference). Case-
   * insensitive SUBSTRING containment only (either direction) — no edit-
   * distance or other fuzzy metric: containment has near-zero false-positive
   * surface on real ids (`cache` ⊂ `redis-cache`) where edit-distance would
   * also fire on short, genuinely-unrelated ids. Only compares observed-only
   * target ids against static-only target ids — the two buckets whose
   * (in)ability to match is literally the question this hints at. A reader
   * decides whether to rename one side to align; the engine only ever
   * suggests, never merges.
   */
  nameSimilarityHints: readonly NameSimilarityHint[];
  /**
   * Count of rows (from EITHER side) with `from === to` that were excluded
   * from every bucket rather than silently entering one — see
   * `computeTopologyEdgeDiff`'s doc for the concrete incident (a browser RUM
   * span pointing at the app's own domain, misread by http.client-span
   * extraction as "this service calls itself"). The STATIC side's version
   * of this bug class was already fixed at the adapter layer (an env var
   * happening to hold the component's own address) — this check is
   * defense-in-depth for the OBSERVED side, which is externally-produced
   * data this engine does not control, not the primary guard.
   */
  selfLoopEdgesExcluded: number;
}

/** One row of the `--compare-edges` file — see `loadObservedEdges`'s doc (cli/commands/topology.ts) for the file contract. Declared structurally here (not imported from the CLI layer) so this view module never depends downward on `cli/`. */
export interface ObservedEdgePair {
  from: string;
  to: string;
  /**
   * Queue-mediated discriminator — either this OR `kind === "consumer"` is
   * enough to route the pair straight to the `"queue-mediated"` category
   * (see that category's doc on `EdgeDiffCategory`). ANY row for a given
   * (from, to) pair carrying either flag makes the WHOLE pair queue-mediated
   * — even one that also happens to have a plain row for the same pair,
   * and even if a static edge exists for the exact same (source, target):
   * the observed evidence's own account of HOW the pair was seen wins over
   * an incidental endpoint-pair match (see `computeTopologyEdgeDiff`'s
   * classification loop for why treating that as "confirmed" would
   * fabricate a direct-call claim the data doesn't support).
   */
  viaQueue?: boolean | undefined;
  /** Open string, not an enum — same "adapter-invented vocabulary" posture as `TopologyHint.toKind`. Only the literal `"consumer"` is currently interpreted (as an alternate queue-mediated signal to `viaQueue`); other values are accepted and ignored, not rejected. */
  kind?: string | undefined;
}

/** Same JSON-tuple key convention as `computeTopologyModel`'s own `key`, and for the same reason: a delimited string join can collide if an id ever contained the delimiter. */
function edgePairKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

export interface TopologyEdgeDiffOptions {
  /**
   * Component ids whose telemetry is trustworthy enough that "this edge
   * never showed up in the observed data" is real evidence, not silence —
   * see `TopologyEdgeDiffSummary.observableScopeDeclared`'s doc for the
   * (deliberately conservative) default when this is omitted entirely.
   * An id here that never appears as any static edge's source is harmless
   * (no classification depends on it) — this is a SOURCE-side allowlist,
   * not a claim that every listed id necessarily appears anywhere.
   */
  observableComponents?: readonly string[];
  /**
   * `toKind` values (same adapter-invented vocabulary as `TopologyNode`'s
   * `toKind`) whose EXTERNAL targets this observed dataset's collection
   * method can actually see — the TARGET-side counterpart to
   * `observableComponents`'s source-side allowlist. Real incident that
   * added this: an observed-edges file built from HTTP client spans could
   * see `toKind: "external"`/`"objectstore"` targets (real HTTP calls) but
   * structurally can NEVER see a `toKind: "datastore"` (direct Postgres/
   * Redis connection) or `toKind: "queue"` (already handled separately —
   * see the `"queue-mediated"` category) edge, no matter how alive it is —
   * those protocols never produce an HTTP client span to trace. Without
   * this axis, those edges were landing in `static-only` ("maybe dead")
   * when the true reason was "this observation method never had a chance".
   * Same conservative-default posture as `observableComponents`: omitted
   * entirely → every external-target edge defaults to `unobservable` (see
   * `TopologyEdgeDiffSummary.targetKindsScopeDeclared`'s doc) rather than
   * assuming every external kind is covered.
   *
   * Only applies when the STATIC edge's target is itself an EXTERNAL node
   * (`TopologyNode.kind === "external"`) — a target that IS a declared
   * component is a plain service-to-service call, which the same parent-
   * child trace-chain methodology that produces `queue-mediated`'s sibling
   * "service" rows can always in principle observe; gating that on this
   * option too would conflate two different questions (component targets
   * are already covered by `observableComponents`'s SOURCE-side check).
   *
   * Also does not apply to an external target with NO `toKind` at all (the
   * adapter never tagged one) — that is a different situation from an
   * untrusted/undeclared KIND: this option's conservative default handles
   * "the adapter said X, but nobody declared X trustworthy"; an untagged
   * target gives it nothing to distrust, and gating on absence-of-a-kind
   * would silently change behavior for every adapter that never adopted
   * `toKind` at all (this option is scoped to adapters that DO tag it
   * meaningfully). An untagged external target's classification depends on
   * `observableComponents` alone, same as before this option existed.
   */
  observableTargetKinds?: readonly string[];
}

/**
 * PURE. Diffs `model.edges` (the extractor's own output) against
 * `observed` — see the module doc above for why this side, not a
 * hand-authored one. Bucketing is exactly the plan's own §4 wording:
 * both sides → confirmed; observed only → an extractor blind spot;
 * static only → EITHER a dead/untested path OR an observation gap,
 * and telling those two apart is exactly what `options.observableComponents`
 * is for (see `unobservable`'s doc on `EdgeDiffCategory` / `TopologyEdgeDiffSummary`
 * for the incident that made this a hard split rather than a footnote).
 */
export function computeTopologyEdgeDiff(
  model: TopologyModel,
  observed: readonly ObservedEdgePair[],
  options: TopologyEdgeDiffOptions = {},
): TopologyEdgeDiff {
  const observableScopeDeclared = options.observableComponents !== undefined;
  const observableSet = new Set(options.observableComponents ?? []);
  const targetKindsScopeDeclared = options.observableTargetKinds !== undefined;
  const observableTargetKindSet = new Set(options.observableTargetKinds ?? []);

  // Self-loop guard (both sides) — see `TopologyEdgeDiff.selfLoopEdgesExcluded`'s
  // doc for the concrete incident (a browser RUM span misread as "this
  // service calls itself"). Excluded BEFORE either side's map is built, so a
  // self-loop can never enter any bucket, never inflate `observedTotal`, and
  // never create a phantom node. `computeTopologyModel`'s own static edges
  // are deliberately left untouched — this filter is local to the diff
  // feature, not a change to the plain (no --compare-edges) render path.
  const staticEdgesNoSelfLoop = model.edges.filter((e) => e.source !== e.target);
  const observedNoSelfLoop = observed.filter((o) => o.from !== o.to);
  const selfLoopEdgesExcluded =
    model.edges.length -
    staticEdgesNoSelfLoop.length +
    (observed.length - observedNoSelfLoop.length);

  const staticByKey = new Map(
    staticEdgesNoSelfLoop.map((e) => [edgePairKey(e.source, e.target), e]),
  );

  // Keyed by DISTINCT (from, to) pair — `observedByKey.size` below is what
  // `summary.observedTotal` reads directly, so it is a distinct-pair count by
  // construction. `count` on each entry tracks OCCURRENCES within that same
  // distinct pair (how many rows in the file repeated it) and only ever
  // surfaces as the per-edge `observedCount` — it never feeds `observedTotal`.
  // `isQueue` is true iff ANY row for this pair carried `viaQueue`/`kind ===
  // "consumer"` — see `ObservedEdgePair.viaQueue`'s doc for why one such row
  // makes the WHOLE pair queue-mediated.
  const observedByKey = new Map<
    string,
    { from: string; to: string; count: number; isQueue: boolean }
  >();
  for (const o of observedNoSelfLoop) {
    const key = edgePairKey(o.from, o.to);
    const rowIsQueue = o.viaQueue === true || o.kind === "consumer";
    const existing = observedByKey.get(key);
    if (existing) {
      existing.count++;
      existing.isQueue = existing.isQueue || rowIsQueue;
    } else {
      observedByKey.set(key, { from: o.from, to: o.to, count: 1, isQueue: rowIsQueue });
    }
  }

  const knownIds = new Set(model.nodes.map((n) => n.id));
  // Target id -> its node, for the target-kind observability check below —
  // only meaningful for `kind === "external"` nodes (see
  // `TopologyEdgeDiffOptions.observableTargetKinds`'s doc on why a
  // component-kind target skips this check entirely).
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));

  // Node ids the static side already shows pointing at a queue-kind
  // dependency (`toKind === "queue"`) — used ONLY for the non-authoritative
  // `queueStaticEvidence` corroboration below, never for classification (see
  // that field's own doc on `TopologyEdgeDiffEdge`).
  const queueTargetIds = new Set(
    model.nodes.filter((n) => n.kind === "external" && n.toKind === "queue").map((n) => n.id),
  );
  const staticQueueSources = new Set(
    staticEdgesNoSelfLoop.filter((e) => queueTargetIds.has(e.target)).map((e) => e.source),
  );

  const extraNodes = new Map<string, TopologyNode>();
  for (const o of observedByKey.values()) {
    for (const id of [o.from, o.to]) {
      if (knownIds.has(id) || extraNodes.has(id)) continue;
      extraNodes.set(id, { id, label: id, kind: "external", observedOnly: true });
    }
  }

  /**
   * Whether a static edge's TARGET is a kind this observation method could
   * ever have seen, regardless of source telemetry health — the second
   * observability axis (see `TopologyEdgeDiffOptions.observableTargetKinds`'s
   * doc). A component-kind target always passes (covered by the SOURCE-side
   * check instead); an external-kind target needs its `toKind` in the
   * declared allowlist, with the same conservative default as the source
   * axis when the allowlist was never declared at all.
   */
  function targetKindObservable(target: string): boolean {
    const node = nodeById.get(target);
    if (!node || node.kind !== "external") return true;
    // No `toKind` at all (the adapter never tagged one) is NOT the same as
    // an untrusted/unlisted kind: the conservative default elsewhere in this
    // feature applies when the CALLER withheld a declaration about
    // something the adapter DID say — here the adapter said nothing, so
    // there is no kind to distrust, and gating on it anyway would silently
    // change behavior for every adapter that never adopted `toKind` (this
    // whole option is opt-in scoped to adapters that DO tag it meaningfully
    // — see the option's own doc for the `datastore`/`objectstore` incident
    // that motivated it). Falls through to the SOURCE-side check alone,
    // same as before this axis existed.
    if (node.toKind === undefined) return true;
    return targetKindsScopeDeclared && observableTargetKindSet.has(node.toKind);
  }

  const allKeys = new Set([...staticByKey.keys(), ...observedByKey.keys()]);
  const edges: TopologyEdgeDiffEdge[] = [];
  let targetKindsUncheckable = 0;
  for (const key of allKeys) {
    const s = staticByKey.get(key);
    const o = observedByKey.get(key);
    // At least one of s/o is always defined (key came from one of their own
    // keyspaces) — the `as string` below reflects that, not an assumption.
    const source = s?.source ?? (o?.from as string);
    const target = s?.target ?? (o?.to as string);

    let category: EdgeDiffCategory;
    let unobservableReason: "source" | "target-kind" | "both" | undefined;
    if (o?.isQueue) {
      // Checked FIRST, ahead of the s&&o "confirmed" case: the observed
      // row's own evidence says this pair was mediated by a queue, and that
      // wins even when a static edge also happens to exist for the exact
      // same (source, target) — an endpoint-pair coincidence is not proof of
      // a direct call, and reporting it "confirmed" would fabricate a claim
      // the observed data does not actually support (see the category doc).
      category = "queue-mediated";
    } else if (s && o) {
      category = "confirmed";
    } else if (s) {
      // Would-be "static-only" — split on TWO independent observability
      // axes, either of which can veto it into `unobservable`:
      //  - SOURCE: is the source component's telemetry trustworthy
      //    (`observableComponents`)? Undeclared → conservatively "no".
      //  - TARGET KIND: can this observation method see this kind of
      //    target at all (`observableTargetKinds`)? Undeclared → same
      //    conservative "no" (see `targetKindObservable`'s doc for why a
      //    component-kind target always passes this one).
      const sourceObservable = observableScopeDeclared && observableSet.has(source);
      const targetObservable = targetKindObservable(target);
      // See `TopologyEdgeDiffSummary.targetKindsUncheckable`'s doc: only
      // meaningful when the caller actually declared a target-kind scope —
      // this tracks edges that scope silently could not reach, not edges
      // that were never going to be checked in the first place. ALSO only
      // meaningful when the SOURCE axis passes: if the source isn't in
      // scope either, this edge is `unobservable` regardless of whether the
      // adapter ever tags a `toKind` — the declared observableTargetKinds
      // never had a chance to matter for it either way, so counting it
      // would inflate the "your declaration didn't reach these edges"
      // signal with edges that scope was never going to save.
      if (targetKindsScopeDeclared && sourceObservable) {
        const targetNode = nodeById.get(target);
        if (targetNode?.kind === "external" && targetNode.toKind === undefined) {
          targetKindsUncheckable++;
        }
      }
      if (sourceObservable && targetObservable) {
        category = "static-only";
      } else {
        category = "unobservable";
        unobservableReason =
          !sourceObservable && !targetObservable
            ? "both"
            : !sourceObservable
              ? "source"
              : "target-kind";
      }
    } else {
      category = "observed-only";
    }

    const origin: "static" | "observed" | "both" =
      category === "confirmed"
        ? "both"
        : category === "static-only" || category === "unobservable"
          ? "static"
          : "observed";

    edges.push({
      source,
      target,
      category,
      origin,
      ...(s ? { staticCount: s.count, evidence: s.evidence } : {}),
      ...(o ? { observedCount: o.count } : {}),
      ...(category === "observed-only"
        ? { observedOnlyKnownEndpoints: knownIds.has(source) && knownIds.has(target) }
        : {}),
      ...(category === "queue-mediated"
        ? {
            queueStaticEvidence: staticQueueSources.has(source) && staticQueueSources.has(target),
          }
        : {}),
      ...(unobservableReason !== undefined ? { unobservableReason } : {}),
    });
  }
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  const confirmed = edges.filter((e) => e.category === "confirmed").length;
  const staticOnly = edges.filter((e) => e.category === "static-only").length;
  const observedOnly = edges.filter((e) => e.category === "observed-only").length;
  const unobservable = edges.filter((e) => e.category === "unobservable").length;
  const queueMediated = edges.filter((e) => e.category === "queue-mediated").length;
  // Purely a distinct-pair count of the observed side, regardless of
  // category — no longer the coverage denominator (see staticCoverage's own
  // doc for the formula this pivot replaced it with).
  const observedTotal = observedByKey.size;

  const staticCoverageDenominator = confirmed + staticOnly;
  // Same principle as the zero-denominator case below, pushed one step
  // further: a percentage computed from a tiny sample (n=1 → 100%, n=2 →
  // 50%/0%) LOOKS exactly as authoritative as one computed from a real
  // sample, even though it carries almost no information — the same
  // "signal lying about its own cause" failure this whole feature exists to
  // catch, just dressed up as a suspiciously round number instead of a
  // suspiciously blank one. Real incident: `observableTargetKinds` correctly
  // shrinking the denominator to confirmed-only (e.g. 1/1) produced a
  // literal "100% covered" reading that a reader could screenshot and
  // report as "static extraction is perfect" — as misleading as the
  // original 5%-from-an-inflated-denominator bug this axis was built to
  // fix, just inverted. Below this threshold, `staticCoverage` stays `null`
  // (with a reason) even though the denominator is nonzero — render/CLI
  // fall back to showing the raw counts instead of a percentage (see
  // `staticCoverageNaReason`'s doc). Not a caller-tunable knob, same
  // posture as `MIN_HINT_LEN`.
  const MIN_COVERAGE_SAMPLE = 5;
  let staticCoverage: number | null;
  let staticCoverageNaReason: string | undefined;
  if (staticCoverageDenominator === 0) {
    staticCoverage = null;
    if (staticEdgesNoSelfLoop.length === 0) {
      staticCoverageNaReason = "静态提取没有产出任何边——这一侧本来就没有可比较的对象，不是覆盖率低";
    } else if (!observableScopeDeclared && !targetKindsScopeDeclared) {
      staticCoverageNaReason =
        "--compare-edges 文件既没有声明 observableComponents 也没有声明 observableTargetKinds——保守起见，两个可观测范围都按未覆盖处理，静态边全部归到了不可观测";
    } else if (!observableScopeDeclared) {
      staticCoverageNaReason =
        "--compare-edges 文件没有声明 observableComponents——保守起见，静态提取到的边全部归到了不可观测，不代表这些边有问题，只是这次没有证据能说明它们本该被观测到";
    } else if (!targetKindsScopeDeclared) {
      staticCoverageNaReason =
        "--compare-edges 文件没有声明 observableTargetKinds——保守起见，指向外部依赖的静态边全部归到了不可观测，不代表这些依赖有问题，只是这次没有证据能说明这类目标本该被观测到";
    } else {
      staticCoverageNaReason =
        "已声明的可观测范围（组件 + 目标类型）没有覆盖到任何一条静态边——声明范围外的边全部归到了不可观测";
    }
  } else if (staticCoverageDenominator < MIN_COVERAGE_SAMPLE) {
    staticCoverage = null;
    staticCoverageNaReason = `可比样本过小（仅 ${staticCoverageDenominator} 条 confirmed+static-only）——这么小的样本算出来的百分比不具代表性，只看原始计数，不当比例引用`;
  } else {
    staticCoverage = confirmed / staticCoverageDenominator;
  }

  // Naming-mismatch hint (issue #23 §4 修正后续): case-insensitive substring
  // containment ONLY, between observed-only target ids and static-only
  // target ids — see `TopologyEdgeDiff.nameSimilarityHints`'s doc for why
  // this metric (not edit distance) and why these two buckets specifically.
  // A minimum length guards against noise from generic short substrings
  // real service ids commonly share without being the same dependency
  // (`"api"`, `"web"`, `"db"` as a bare 3-char fragment would false-positive
  // constantly) — 5 is chosen so the two real incidents that motivated this
  // feature (`"cache"`/`"redis-cache"`, `"model"`/`"model-gateway"`) still
  // match at their shortest side. Not a caller-tunable knob — "宁可少提示也
  // 别乱提示".
  const MIN_HINT_LEN = 5;
  const observedOnlyTargets = new Set(
    edges.filter((e) => e.category === "observed-only").map((e) => e.target),
  );
  const staticOnlyTargets = new Set(
    edges.filter((e) => e.category === "static-only").map((e) => e.target),
  );
  const nameSimilarityHints: NameSimilarityHint[] = [];
  for (const observedId of observedOnlyTargets) {
    const oLower = observedId.toLowerCase();
    if (oLower.length < MIN_HINT_LEN) continue;
    for (const staticId of staticOnlyTargets) {
      const sLower = staticId.toLowerCase();
      if (sLower.length < MIN_HINT_LEN) continue;
      if (oLower === sLower) continue; // would already be a matched pair, not a mismatch
      if (oLower.includes(sLower) || sLower.includes(oLower)) {
        nameSimilarityHints.push({ observedId, staticId });
      }
    }
  }
  nameSimilarityHints.sort(
    (a, b) => a.observedId.localeCompare(b.observedId) || a.staticId.localeCompare(b.staticId),
  );

  return {
    nodes: [...model.nodes, ...[...extraNodes.values()].sort((a, b) => a.id.localeCompare(b.id))],
    edges,
    nameSimilarityHints,
    selfLoopEdgesExcluded,
    summary: {
      confirmed,
      staticOnly,
      observedOnly,
      unobservable,
      queueMediated,
      observedTotal,
      staticCoverage,
      staticCoverageDenominator,
      ...(staticCoverageNaReason !== undefined ? { staticCoverageNaReason } : {}),
      observableScopeDeclared,
      targetKindsScopeDeclared,
      targetKindsUncheckable,
    },
  };
}

/**
 * What `runTopology` hands `renderTopologyHtml` for the `--compare-edges`
 * outcome — a DISCRIMINATED result, not `TopologyEdgeDiff | undefined`,
 * because "the flag was never passed" and "the flag was passed but the file
 * was unreadable/invalid" must render (and log) differently: the latter is a
 * loud failure (see `loadObservedEdges`'s doc on why a bad file must never
 * silently degrade to "0 observed edges" — that would print a technically-
 * true but misleading `staticCoverage: null`/"n/a" instead of surfacing that
 * the comparison never ran at all).
 */
export type EdgeDiffOutcome =
  | { status: "error"; message: string }
  | { status: "ok"; diff: TopologyEdgeDiff };

// ─── render ─────────────────────────────────────────────────────────────

export interface TopologyHtmlMeta {
  title: string;
  stalenessBanner?: string | undefined;
  /**
   * Adapter-authored free text describing what fraction of real service
   * calls this adapter's `topology` hints actually cover (e.g. "17/62 (27%)
   * of non-test fetch call sites are named-env-URL reachable — this is the
   * subset this adapter tags"). ENGINE-AGNOSTIC BY DESIGN: this command has
   * no notion of "fetch call site" — only the adapter that wrote the
   * extractor knows its own coverage, so the note travels with the adapter
   * (an additive `Adapter.topologyCoverageNote` field), not hardcoded here.
   * Absent → a generic, still-honest fallback is shown instead of silence.
   */
  coverageNote?: string | undefined;
}

/** Embed a JSON value in a <script> without letting `</script>` close the tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- deterministic force-directed layout (no RNG — index-seeded) -------------
// Same approach as graph-html.ts's layout(), kept as an independent copy: the
// two views are separate projections and shouldn't share an implementation
// dependency for a ~70-line, self-contained algorithm.

const CANVAS = { w: 1600, h: 1000, pad: 60 };
const FORCE_NODE_CAP = 400;

interface Pt {
  x: number;
  y: number;
}
interface Body {
  x: number;
  y: number;
  fx: number;
  fy: number;
}

/**
 * Structural subset `layout` actually needs — narrower than `TopologyModel`
 * on purpose. `renderTopologyHtml` lays out `edgeDiff.diff.nodes/edges`
 * (model nodes + any extra observed-only ones, and the 3-category diff edge
 * list) when a comparison ran; both that shape and a plain `TopologyModel`
 * satisfy this interface structurally, so one layout implementation serves
 * both without a cast.
 */
interface LayoutGraph {
  nodes: readonly Pick<TopologyNode, "id">[];
  edges: readonly Pick<TopologyEdge, "source" | "target">[];
}

function layout(graph: LayoutGraph): Map<string, Pt> {
  const ids = graph.nodes.map((n) => n.id);
  const n = ids.length;
  const pos = new Map<string, Pt>();
  if (n === 0) return pos;

  const cx = CANVAS.w / 2;
  const cy = CANVAS.h / 2;
  const R = Math.min(CANVAS.w, CANVAS.h) / 2 - CANVAS.pad;
  ids.forEach((id, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });

  if (n > 1 && n <= FORCE_NODE_CAP) {
    const idx = new Map(ids.map((id, i) => [id, i]));
    const P: Body[] = ids.map((id) => {
      const p = pos.get(id) as Pt;
      return { x: p.x, y: p.y, fx: 0, fy: 0 };
    });
    const adj: Array<[Body, Body]> = [];
    for (const e of graph.edges) {
      if (e.source === e.target) continue; // a self-edge contributes no spring force; skip rather than compute a no-op
      const a = idx.get(e.source);
      const b = idx.get(e.target);
      const ba = a === undefined ? undefined : P[a];
      const bb = b === undefined ? undefined : P[b];
      if (ba && bb) adj.push([ba, bb]);
    }

    const ITER = 260;
    const REP = 90_000;
    const SPRING = 0.012;
    const REST = 180;
    for (let step = 0; step < ITER; step++) {
      const cool = 1 - step / ITER;
      for (const p of P) {
        p.fx = 0;
        p.fy = 0;
      }
      for (let i = 0; i < n; i++) {
        const a = P[i];
        if (!a) continue;
        for (let j = i + 1; j < n; j++) {
          const b = P[j];
          if (!b) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (i % 2 === 0 ? 1 : -1) * 0.1;
            dy = 0.1;
            d2 = dx * dx + dy * dy;
          }
          const f = REP / d2;
          const dist = Math.sqrt(d2);
          const ux = (dx / dist) * f;
          const uy = (dy / dist) * f;
          a.fx += ux;
          a.fy += uy;
          b.fx -= ux;
          b.fy -= uy;
        }
      }
      for (const [a, b] of adj) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = SPRING * (dist - REST);
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;
        a.fx += ux;
        a.fy += uy;
        b.fx -= ux;
        b.fy -= uy;
      }
      for (const p of P) {
        p.fx += (cx - p.x) * 0.004;
        p.fy += (cy - p.y) * 0.004;
        p.x += Math.max(-40, Math.min(40, p.fx)) * cool;
        p.y += Math.max(-40, Math.min(40, p.fy)) * cool;
      }
    }
    ids.forEach((id, i) => {
      const p = P[i];
      if (p) pos.set(id, { x: p.x, y: p.y });
    });
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pos.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const sx = maxX - minX < 1 ? 1 : (CANVAS.w - 2 * CANVAS.pad) / (maxX - minX);
  const sy = maxY - minY < 1 ? 1 : (CANVAS.h - 2 * CANVAS.pad) / (maxY - minY);
  const s = Math.min(sx, sy);
  for (const p of pos.values()) {
    p.x = CANVAS.pad + (p.x - minX) * s;
    p.y = CANVAS.pad + (p.y - minY) * s;
  }
  return pos;
}

const GENERIC_COVERAGE_FALLBACK =
  "此图只画出 adapter 显式给了 topology 提示的事实，不代表覆盖了目标仓全部服务间调用 —— 该 adapter 未提供具体覆盖率说明。";

/**
 * Standing, adapter-INDEPENDENT reading guide — always shown when there is
 * at least one edge, regardless of what (or whether) `meta.coverageNote`
 * says. Exists because a reader's first instinct on a sparse-looking graph
 * is "this is broken / incomplete", and the most common REAL cause is not
 * missing coverage but a miscalibrated expectation: a naive substring grep
 * for an env-var-name fragment routinely conflates several DIFFERENT
 * variables pointing at DIFFERENT targets — most commonly one internal
 * component and one or more unrelated EXTERNAL vendors that happen to share
 * a naming fragment. An adapter that resolves by exact variable name (the
 * correct, narrower approach) will
 * then legitimately show far fewer internal→internal edges than that grep
 * count implied — sparse internal edges next to denser external ones is the
 * ordinarily-healthy shape, not a sign of a broken extractor. Left as a
 * standing engine-level guarantee rather than folded into `coverageNote` so
 * it protects a reader even against an adapter that never opts into that
 * field at all.
 */
const EDGE_DENSITY_NOTE =
  "读图提示：内部组件之间的边通常比指向外部依赖（数据库/队列/第三方 API）的边少得多——这是常见的健康形态，不是遗漏的信号。如果按对某个 env 变量名子串的原始 grep 计数来预期这张图该有多少条边，容易被误导：同一个子串常常横跨多个指向不同目标的变量（尤其是把一个内部组件和某个外部厂商的同名后缀混在一起），把它们当同一条边数，会显著高估「应该」出现的内部边数量。";

/**
 * Render the whole self-contained HTML page. Server side embeds nodes (with
 * deterministic positions), edges (with evidence) and the summary as JSON;
 * all SVG is built by the inline script from that data, so free-text labels
 * are escaped by the DOM (createTextNode), never hand-concatenated into
 * markup.
 */
/**
 * Label for an edge-diff category — used in the legend and, once escaped, is
 * never user input, so it's inlined straight into markup below.
 *
 * Wording deliberately avoids "静态提取器的盲区" (PR8's original observed-only
 * label) as the ONLY reading: that phrasing implies static is the baseline
 * and observed is merely grading it, which is exactly the asymmetry this
 * command's edges (each tagged `origin: static|observed|both`, see
 * `TopologyEdgeDiffEdge`) are meant to correct — static and observed are two
 * co-equal fact sources, each with its own blind spot.
 */
const EDGE_DIFF_CATEGORY_LABEL: Readonly<Record<EdgeDiffCategory, string>> = {
  confirmed: "静态与观测都印证（两个来源一致）",
  "static-only": "仅静态提取到（来源组件可观测、观测里没确认——可能是死路径或未测路径）",
  "observed-only":
    "仅观测到（静态提取没找到这条边——是提取器盲区，还是静态词表压根没建模这个依赖，见每条边详情）",
  unobservable: "不可观测（来源组件的遥测本来就到不了采集端——不是死路径，是这次没法比较）",
  "queue-mediated":
    "队列中介（观测到经队列送达，生产者/消费者在静态侧配不上对——不是缺失，是没法配对，不计入覆盖率）",
};

/**
 * `edgeDiff` is the ONLY new parameter — omitted entirely (not just
 * `undefined`-valued) by every caller that doesn't pass `--compare-edges`,
 * so every branch below that reads it must produce EXACTLY the same output
 * as before this field existed. That is what keeps every pre-existing
 * `renderTopologyHtml(model, meta)` call (and the tests that assert on its
 * exact byte output) unaffected by this feature.
 */
export function renderTopologyHtml(
  model: TopologyModel,
  meta: TopologyHtmlMeta,
  edgeDiff?: EdgeDiffOutcome,
): string {
  const diff = edgeDiff?.status === "ok" ? edgeDiff.diff : undefined;
  const renderNodes = diff ? diff.nodes : model.nodes;
  const layoutGraph: LayoutGraph = diff ? { nodes: diff.nodes, edges: diff.edges } : model;
  const pos = layout(layoutGraph);
  const nodes = renderNodes.map((nd) => {
    const p = pos.get(nd.id) as Pt;
    return { ...nd, x: Math.round(p.x), y: Math.round(p.y) };
  });
  const data = safeJson({
    nodes,
    edges: model.edges,
    ...(diff ? { edgeDiff: { edges: diff.edges, summary: diff.summary } } : {}),
    summary: model.summary,
    unattributedCount: model.unattributedCount,
    factsRan: model.factsRan,
  });

  // `?.trim() || fallback`, not `??`: an adapter passing `""` (or
  // whitespace) must fall back too — the red line is "this caveat is ALWAYS
  // visible", and `??` alone only catches undefined/null, letting an empty
  // string silently render as a blank line instead of the fallback text.
  const coverageNote = meta.coverageNote?.trim() || GENERIC_COVERAGE_FALLBACK;

  // Loud on purpose (io.error-severity styling, same "✗"-class message
  // `runTopology`'s CLI side prints) — see `EdgeDiffOutcome`'s doc: a bad
  // --compare-edges file must never look like "nothing to report".
  const edgeDiffErrorBanner =
    edgeDiff?.status === "error"
      ? `<p class="tg-warn">✗ --compare-edges 提供了但加载失败，本次未生成对账：${escapeText(edgeDiff.message)}</p>`
      : "";

  const edgeDiffCoverageBanner = diff
    ? (() => {
        const s = diff.summary;
        // Three distinct presentations, not two — a real incident showed
        // why: computing a percentage from a tiny denominator (e.g. 1/1)
        // reads exactly as authoritative as one from a real sample, even
        // though it carries almost no information — the "n/a with a
        // reason" treatment already used for a zero denominator applies
        // just as much here, but the raw counts (unlike the zero case)
        // ARE still worth showing, since they exist and aren't themselves
        // misleading — only the ratio computed from them would be.
        const covText =
          s.staticCoverage !== null
            ? `${s.confirmed}/${s.staticCoverageDenominator} = ${(s.staticCoverage * 100).toFixed(0)}%`
            : s.staticCoverageDenominator === 0
              ? `n/a（${escapeText(s.staticCoverageNaReason ?? "没有可比较的对象")}）`
              : `${s.confirmed}/${s.staticCoverageDenominator}（不给百分比：${escapeText(s.staticCoverageNaReason ?? "样本过小")}）`;
        return `<p class="tg-note">ℹ 静态提取与线上观测是两个各有盲区、同等地位的事实来源——静态看不到运行时才决定的调用，观测只能看到遥测真正到达采集端的那部分。下面这个"静态覆盖率"只回答一件事：静态提取到的、且理论上可以直接比较的边（不含不可观测、不含队列中介，两者被排除的理由不同，见下方）里，有多少条被观测证实了：<b>${covText}</b>。confirmed ${s.confirmed} · 仅静态 ${s.staticOnly} · 仅观测 ${s.observedOnly} · 不可观测 ${s.unobservable} · 队列中介 ${s.queueMediated}</p>`;
      })()
    : "";

  // Separate from the coverage banner above on purpose: this is about WHICH
  // default produced the `unobservable` count, not about the coverage ratio
  // itself — a reader who only skims the coverage line must still see this.
  // Two independent banners (source scope, target-kind scope) rather than
  // one merged warning — a reader declaring one but not the other needs to
  // know WHICH one is still missing, not just "something's undeclared".
  const edgeDiffObservabilityBanner =
    diff && !diff.summary.observableScopeDeclared
      ? `<p class="tg-warn">⚠ 未声明可观测组件范围（--compare-edges 文件没给 observableComponents）——保守起见，全部"仅静态提取"的边都归到了"不可观测"，不代表这些边被判定为死路径，只是这次没有证据。声明可观测范围后，范围内确实缺失观测的边才会被标成"仅静态提取"。</p>`
      : "";

  const edgeDiffTargetKindsBanner =
    diff && !diff.summary.targetKindsScopeDeclared
      ? `<p class="tg-warn">⚠ 未声明可观测目标类型（--compare-edges 文件没给 observableTargetKinds）——保守起见，所有指向外部依赖的"仅静态提取"边都归到了"不可观测"。这不是说这些依赖有问题，是这次的观测方法本来就可能看不到某些类型的目标（比如直连数据库/队列，永远不会产生可追踪的 HTTP 调用）。声明这次观测方法真正能看到哪些目标类型后，看不到的类型会保持"不可观测"，看得到但确实没观测到的才会标成"仅静态提取"。</p>`
      : "";

  // Separate from the banner above: THIS fires even when observableTargetKinds
  // WAS declared, for the narrower case where the declared scope silently
  // doesn't reach some edges because the adapter never tagged their target
  // with a toKind at all — see `TopologyEdgeDiffSummary.targetKindsUncheckable`'s
  // doc for why that's a different failure than "nobody declared anything".
  const edgeDiffTargetKindsUncheckableBanner =
    diff?.summary.targetKindsScopeDeclared && diff.summary.targetKindsUncheckable > 0
      ? `<p class="tg-warn">⚠ ${escapeText(String(diff.summary.targetKindsUncheckable))} 条边的目标没有 toKind 标注——你声明的 observableTargetKinds 对它们不生效（只按来源组件是否可观测单独判断），不代表这个声明本身有问题，是适配器没给这些目标标类型。</p>`
      : "";

  // Also separate from the coverage banner: this is about whether ANY
  // observed data participated at all, not about how the comparable subset
  // broke down. An empty `edges` array in the --compare-edges file is a
  // valid, successful load (see `loadObservedEdges`'s doc) — but a reader
  // must not mistake "0 observed edges" for "we ran the comparison and
  // found nothing wrong".
  const edgeDiffEmptyObservedBanner =
    diff && diff.summary.observedTotal === 0
      ? `<p class="tg-warn">⚠ --compare-edges 文件里 edges 是空的——本次没有任何观测数据参与比较，下面所有分类都只是静态侧自己的默认判断（可观测范围等），不代表真的比对过运行时数据。</p>`
      : "";

  // Defense-in-depth note, not an error — see `TopologyEdgeDiff.selfLoopEdgesExcluded`'s
  // doc for the concrete artifact (a browser RUM span pointing at the app's
  // own domain) this guards against.
  const edgeDiffSelfLoopBanner =
    diff && diff.selfLoopEdgesExcluded > 0
      ? `<p class="tg-note">ℹ 排除了 ${escapeText(String(diff.selfLoopEdgesExcluded))} 条"指向自己"的边（source === target）——这类边几乎总是采集方法的伪影（比如浏览器请求把自己的域名也算成一次出站调用），不计入任何桶。</p>`
      : "";

  // Suggestion only, never an auto-merge — see `TopologyEdgeDiff.nameSimilarityHints`'s
  // doc for why (a wrong merge would silently hide a real difference; this
  // engine only ever points at a suspicious pair and leaves the call to a
  // reader who knows the real answer).
  const edgeDiffNameSimilarityBanner =
    diff && diff.nameSimilarityHints.length > 0
      ? `<p class="tg-warn">⚠ ${escapeText(String(diff.nameSimilarityHints.length))} 组"仅观测到"和"仅静态提取"的目标名字很像，可能是同一个依赖在两侧叫法不同（不是自动合并，需要你确认）：${diff.nameSimilarityHints
          .map((h) => `${escapeText(h.observedId)} ↔ ${escapeText(h.staticId)}`)
          .join("；")}</p>`
      : "";

  const edgeDiffLegend = diff
    ? `<div id="tg-edgediff-legend">
    <span class="tg-legend-item"><span class="tg-line tg-line-confirmed"></span><span>${escapeText(EDGE_DIFF_CATEGORY_LABEL.confirmed)}</span></span>
    <span class="tg-legend-item"><span class="tg-line tg-line-static-only"></span><span>${escapeText(EDGE_DIFF_CATEGORY_LABEL["static-only"])}</span></span>
    <span class="tg-legend-item"><span class="tg-line tg-line-observed-only"></span><span>${escapeText(EDGE_DIFF_CATEGORY_LABEL["observed-only"])}</span></span>
    <span class="tg-legend-item"><span class="tg-line tg-line-unobservable"></span><span>${escapeText(EDGE_DIFF_CATEGORY_LABEL.unobservable)}</span></span>
    <span class="tg-legend-item"><span class="tg-line tg-line-queue-mediated"></span><span>${escapeText(EDGE_DIFF_CATEGORY_LABEL["queue-mediated"])}</span></span>
    ${
      diff.nodes.length > model.nodes.length
        ? `<span class="tg-legend-item"><span class="tg-sq tg-sq-observed-only"></span><span>只在观测边里出现的节点（不是声明的组件，也没被静态提取到）</span></span>`
        : ""
    }
  </div>`
    : "";

  return `<div id="tg-root">
  <header id="tg-header">
    <h1>codeontic — topology</h1>
    <p class="tg-sub">${escapeText(meta.title)}</p>
    ${meta.stalenessBanner ? `<p class="tg-stale">${escapeText(meta.stalenessBanner)}</p>` : ""}
    ${
      model.factsRan
        ? ""
        : `<p class="tg-warn">⚠ no facts extracted (no --repo-root, or the target isn't a git checkout) — showing declared components only, zero edges. Pass --repo-root to draw real service-call edges.</p>`
    }
    <p class="tg-note">⚠ ${escapeText(coverageNote)}</p>
    ${model.summary.edges > 0 ? `<p class="tg-note">ℹ ${escapeText(EDGE_DENSITY_NOTE)}</p>` : ""}
    ${
      model.unattributedCount > 0
        ? `<p class="tg-warn">⚠ ${model.unattributedCount} topology-tagged fact(s) came from a file that matched no declared component — bucketed as "${escapeText(UNATTRIBUTED_NODE_ID)}" below, not dropped. Extend \`.codeontic/config.json\`'s \`components\` paths to attribute them.</p>`
        : ""
    }
    ${edgeDiffErrorBanner}
    ${edgeDiffCoverageBanner}
    ${edgeDiffObservabilityBanner}
    ${edgeDiffTargetKindsBanner}
    ${edgeDiffTargetKindsUncheckableBanner}
    ${edgeDiffEmptyObservedBanner}
    ${edgeDiffSelfLoopBanner}
    ${edgeDiffNameSimilarityBanner}
    <div id="tg-summary"></div>
    <div id="tg-legend"></div>
    ${edgeDiffLegend}
  </header>
  <div id="tg-stage"><svg id="tg-svg" viewBox="0 0 ${CANVAS.w} ${CANVAS.h}" preserveAspectRatio="xMidYMid meet"><g id="tg-view"></g></svg></div>
  <div id="tg-tip" hidden></div>
  <script type="application/json" id="tg-data">${data}</script>
  <style>${STYLE}</style>
  <script>${SCRIPT}</script>
</div>`;
}

// Theme-aware; light + dark both styled. Role colors chosen for pairwise
// distinguishability at a glance — this page's entire job is "which kind of
// thing am I looking at", so hue separation matters more than palette taste.
const STYLE = `
#tg-root{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2333;background:#f7f8fb;margin:0;min-height:100vh}
#tg-header{padding:14px 18px;border-bottom:1px solid #e2e6ef}
#tg-header h1{font-size:15px;margin:0 0 2px;font-weight:650}
.tg-sub{margin:0;font-size:12px;color:#5b6577}
.tg-stale{margin:6px 0 0;font-size:11px;color:#7a8394}
.tg-warn{margin:6px 0 0;font-size:12px;color:#b45309;font-weight:600}
.tg-note{margin:6px 0 0;font-size:12px;color:#7a8394}
#tg-summary{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
#tg-legend{margin-top:8px;display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:#5b6577}
.tg-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;border:1px solid transparent}
.tg-pill .tg-dot{width:9px;height:9px;border-radius:50%}
.tg-count{font-variant-numeric:tabular-nums;font-weight:650}
.tg-legend-item{display:inline-flex;align-items:center;gap:5px}
.tg-legend-item .tg-dot{width:9px;height:9px;border-radius:50%}
.tg-legend-item .tg-sq{width:9px;height:9px;border-radius:2px}
#tg-edgediff-legend{margin-top:6px;display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:#5b6577}
.tg-line{display:inline-block;width:20px;height:0;border-top-width:3px;border-top-style:solid}
.tg-line-confirmed{border-color:#16a34a}
.tg-line-static-only{border-color:#94a3b8;border-top-style:dashed}
.tg-line-observed-only{border-color:#dc2626}
.tg-line-unobservable{border-color:#a855f7;border-top-style:dotted}
.tg-line-queue-mediated{border-color:#a16207;border-top-style:dashed}
.tg-sq-observed-only{width:9px;height:9px;border-radius:2px;border:1.5px dashed #6b7280;background:transparent}
#tg-stage{position:relative;height:calc(100vh - 170px);overflow:hidden;cursor:grab}
#tg-stage.drag{cursor:grabbing}
#tg-svg{width:100%;height:100%;display:block}
.tg-edge{stroke:#aab2c2;fill:none;stroke-width:1.4}
.tg-edge.dim{opacity:.08}
.tg-edge-confirmed{stroke:#16a34a}
.tg-edge-static-only{stroke:#94a3b8;stroke-dasharray:6 4}
.tg-edge-observed-only{stroke:#dc2626}
.tg-edge-unobservable{stroke:#a855f7;stroke-dasharray:1 4;stroke-linecap:round}
.tg-edge-queue-mediated{stroke:#a16207;stroke-dasharray:2 2 8 2}
.tg-node{cursor:pointer}
.tg-node circle,.tg-node rect{stroke:#fff;stroke-width:2}
.tg-node text{font-size:12px;fill:#1c2333;paint-order:stroke;stroke:#f7f8fb;stroke-width:3px}
.tg-node.dim{opacity:.12}
.frontend{--c:#2563eb}.api{--c:#7c3aed}.worker{--c:#d97706}.sandbox{--c:#059669}.library{--c:#64748b}
.ext-datastore{--c:#0891b2}.ext-queue{--c:#a16207}.ext-objectstore{--c:#db2777}.ext-service{--c:#475569}.ext-external{--c:#6b7280}
.unattributed{--c:#dc2626}
.tg-node circle{fill:var(--c)}
.tg-node.library rect,.tg-node.external rect{fill:#fff;stroke:var(--c);stroke-width:2.5}
.tg-node.unattributed circle{fill:#fff;stroke:var(--c);stroke-width:2.5;stroke-dasharray:4 3}
.tg-node.tg-observed-only-node rect{stroke-dasharray:4 3}
#tg-tip{position:absolute;pointer-events:none;background:#111827;color:#f3f4f6;font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;max-width:320px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:5}
#tg-tip b{color:#fff}
#tg-tip .k{color:#93c5fd}
#tg-tip .ev{color:#a5b4fc;display:block}
@media (prefers-color-scheme:dark){
 #tg-root{color:#e5e9f0;background:#0e1117}
 #tg-header{border-color:#232a36}
 .tg-sub{color:#9aa4b5}.tg-stale{color:#6b7688}.tg-note{color:#6b7688}
 .tg-warn{color:#fbbf24}
 .tg-edge{stroke:#3a4354}
 .tg-edge-static-only{stroke:#525d70}
 #tg-edgediff-legend{color:#9aa4b5}
 .tg-node text{fill:#e5e9f0;stroke:#0e1117}
 .tg-node.library rect,.tg-node.external rect{fill:#0e1117}
}
:root[data-theme="dark"] #tg-root{color:#e5e9f0;background:#0e1117}
:root[data-theme="dark"] #tg-header{border-color:#232a36}
:root[data-theme="dark"] .tg-warn{color:#fbbf24}
:root[data-theme="dark"] #tg-edgediff-legend{color:#9aa4b5}
:root[data-theme="dark"] .tg-node text{fill:#e5e9f0;stroke:#0e1117}
:root[data-theme="dark"] .tg-node.library rect,:root[data-theme="dark"] .tg-node.external rect{fill:#0e1117}
:root[data-theme="light"] #tg-root{color:#1c2333;background:#f7f8fb}
`;

// No template literals / ${} inside — plain concatenation so the whole string
// drops into the page verbatim with no escaping surprises.
const SCRIPT = `
(function(){
 var data=JSON.parse(document.getElementById("tg-data").textContent);
 var ROLE_LABEL={frontend:"前端 / user-facing",api:"平台 API",worker:"后台进程",sandbox:"Sandbox 执行面",library:"共享库（非入口）"};
 var ROLE_ORDER=["frontend","api","worker","sandbox","library"];
 var EXT_LABEL={datastore:"数据存储",queue:"队列",objectstore:"对象存储",service:"服务",external:"外部依赖"};
 var COLOR={frontend:"#2563eb",api:"#7c3aed",worker:"#d97706",sandbox:"#059669",library:"#64748b",
   "ext-datastore":"#0891b2","ext-queue":"#a16207","ext-objectstore":"#db2777","ext-service":"#475569","ext-external":"#6b7280",
   unattributed:"#dc2626"};
 var R={component:14,external:12,unattributed:13};
 function nodeClass(n){
   if(n.kind==="component") return n.role;
   if(n.kind==="external") return "ext-"+(n.toKind&&EXT_LABEL[n.toKind]?n.toKind:"external");
   return "unattributed";
 }
 var byId={}; data.nodes.forEach(function(n){byId[n.id]=n;});
 // When a --compare-edges diff ran, EVERY edge-related loop below (drawing,
 // neighbor computation, tooltip in/out lists) reads this 3-category list
 // instead of the plain static edge list. Falls back to data.edges (the
 // always-present, backward-compatible field) when no diff ran, so this is
 // the ONLY branch point the diff feature needs in the rest of the script.
 var EDGES=data.edgeDiff?data.edgeDiff.edges:data.edges;
 var CAT_LABEL={confirmed:"双向确认","static-only":"仅静态提取","observed-only":"仅观测到",unobservable:"不可观测","queue-mediated":"队列中介"};
 var ORIGIN_LABEL={"static":"静态","observed":"观测",both:"双方"};
 var NS="http://www.w3.org/2000/svg";
 var view=document.getElementById("tg-view");
 var svg=document.getElementById("tg-svg");
 var stage=document.getElementById("tg-stage");
 var tip=document.getElementById("tg-tip");

 // summary chips
 var sum=document.getElementById("tg-summary");
 [["组件",data.summary.components],["外部依赖",data.summary.external],["边",data.summary.edges]].forEach(function(p){
   var el=document.createElement("span"); el.className="tg-pill"; el.style.background="rgba(0,0,0,.04)";
   var lab=document.createElement("span"); lab.textContent=p[0]; el.appendChild(lab);
   var c=document.createElement("span"); c.className="tg-count"; c.textContent=p[1]; el.appendChild(c);
   sum.appendChild(el);
 });

 // legend: component roles present, then external kinds present, then unattributed
 var legend=document.getElementById("tg-legend");
 var rolesSeen={}, extSeen={}, hasUnattributed=false;
 data.nodes.forEach(function(n){
   if(n.kind==="component") rolesSeen[n.role]=1;
   else if(n.kind==="external") extSeen[nodeClass(n)]=1;
   else hasUnattributed=true;
 });
 ROLE_ORDER.forEach(function(r){
   if(!rolesSeen[r]) return;
   var el=document.createElement("span"); el.className="tg-legend-item";
   var dot=document.createElement("span"); dot.className="tg-dot"; dot.style.background=COLOR[r]; el.appendChild(dot);
   var lab=document.createElement("span"); lab.textContent=ROLE_LABEL[r]; el.appendChild(lab);
   legend.appendChild(el);
 });
 Object.keys(extSeen).sort().forEach(function(cls){
   var el=document.createElement("span"); el.className="tg-legend-item";
   var sq=document.createElement("span"); sq.className="tg-sq"; sq.style.background=COLOR[cls]; el.appendChild(sq);
   var kind=cls.replace("ext-",""); var lab=document.createElement("span"); lab.textContent="外部："+(EXT_LABEL[kind]||kind); el.appendChild(lab);
   legend.appendChild(el);
 });
 if(hasUnattributed){
   var el=document.createElement("span"); el.className="tg-legend-item";
   var dot=document.createElement("span"); dot.className="tg-dot"; dot.style.background=COLOR.unattributed; el.appendChild(dot);
   var lab=document.createElement("span"); lab.textContent="未归属文件（配置缺口）"; el.appendChild(lab);
   legend.appendChild(el);
 }

 // edges first (under nodes)
 var edgeEls=[];
 EDGES.forEach(function(e){
   var a=byId[e.source], b=byId[e.target]; if(!a||!b) return;
   var ln=document.createElementNS(NS,"line");
   ln.setAttribute("x1",a.x);ln.setAttribute("y1",a.y);ln.setAttribute("x2",b.x);ln.setAttribute("y2",b.y);
   ln.setAttribute("class","tg-edge"+(e.category?" tg-edge-"+e.category:""));
   var w=e.count!==undefined?e.count:Math.max(e.staticCount||0,e.observedCount||0,1);
   ln.setAttribute("stroke-width",Math.min(1+Math.log(1+w),6));
   ln.__e=e; view.appendChild(ln); edgeEls.push(ln);
 });

 // nodes
 var nodeEls=[];
 data.nodes.forEach(function(n){
   var cls=nodeClass(n);
   var g=document.createElementNS(NS,"g"); g.setAttribute("class","tg-node "+n.kind+" "+cls+(n.observedOnly?" tg-observed-only-node":""));
   g.setAttribute("transform","translate("+n.x+","+n.y+")");
   if(cls==="library"||n.kind==="external"){
     var s=(R[n.kind]||12);
     var rc=document.createElementNS(NS,"rect"); rc.setAttribute("x",-s);rc.setAttribute("y",-s);rc.setAttribute("width",s*2);rc.setAttribute("height",s*2);rc.setAttribute("rx",3);
     g.appendChild(rc);
   } else {
     var c=document.createElementNS(NS,"circle"); c.setAttribute("r",R[n.kind]||12); g.appendChild(c);
   }
   var t=document.createElementNS(NS,"text"); t.setAttribute("x",(R[n.kind]||12)+4); t.setAttribute("y",4);
   t.appendChild(document.createTextNode(n.label)); g.appendChild(t);
   g.__n=n; view.appendChild(g); nodeEls.push(g);
   g.addEventListener("mouseenter",function(ev){showTip(n,ev);});
   g.addEventListener("mousemove",function(ev){moveTip(ev);});
   g.addEventListener("mouseleave",function(){tip.hidden=true;});
   g.addEventListener("click",function(ev){ev.stopPropagation();focus(n);});
 });

 var neigh={}; data.nodes.forEach(function(n){neigh[n.id]={};});
 EDGES.forEach(function(e){ if(neigh[e.source]&&neigh[e.target]){neigh[e.source][e.target]=1;neigh[e.target][e.source]=1;} });
 var focused=null;

 function apply(){
   nodeEls.forEach(function(g){
     var n=g.__n;
     var dim=focused && focused!==n.id && !neigh[focused][n.id];
     g.classList.toggle("dim",!!dim);
   });
   edgeEls.forEach(function(ln){
     var e=ln.__e;
     var dim=focused && e.source!==focused && e.target!==focused;
     ln.classList.toggle("dim",!!dim);
   });
 }
 function focus(n){ focused=(focused===n.id)?null:n.id; apply(); }
 svg.addEventListener("click",function(){ if(focused){focused=null;apply();} });

 function roleOrKindLabel(n){
   if(n.kind==="component") return ROLE_LABEL[n.role]||n.role;
   if(n.kind==="external") return "外部依赖"+(n.toKind?(" · "+n.toKind):"")+(n.observedOnly?"（仅观测到，静态未提取）":"");
   return "未归属文件桶";
 }
 function edgeLabel(e){
   if(!e.category) return " ×"+e.count;
   var counts=[];
   if(e.staticCount!==undefined) counts.push("静态×"+e.staticCount);
   if(e.observedCount!==undefined) counts.push("观测×"+e.observedCount);
   var extra="";
   if(e.category==="observed-only"){
     extra = e.observedOnlyKnownEndpoints ? "，两端都是已知节点（提取器盲区）" : "，目标不在静态词表里（未建模的依赖）";
   } else if(e.category==="queue-mediated" && e.queueStaticEvidence){
     extra = "，静态侧两端都有指向队列的边";
   } else if(e.category==="unobservable" && e.unobservableReason){
     var UNOBS_REASON={source:"来源组件遥测不可信","target-kind":"目标类型这次看不到",both:"来源和目标类型都看不到"};
     extra = "，"+(UNOBS_REASON[e.unobservableReason]||e.unobservableReason);
   }
   var origin=e.origin&&ORIGIN_LABEL[e.origin] ? (ORIGIN_LABEL[e.origin]+"来源 · ") : "";
   return " ["+origin+(CAT_LABEL[e.category]||e.category)+(counts.length?(" "+counts.join(" ")):"")+extra+"]";
 }
 function showTip(n,ev){
   var h="<b>"+esc(n.label)+"</b><br>"+esc(roleOrKindLabel(n));
   var out=[], into=[];
   EDGES.forEach(function(e){ if(e.source===n.id) out.push(e); if(e.target===n.id) into.push(e); });
   if(out.length){ h+="<br><span class=k>出边：</span>"; out.forEach(function(e){ h+="<span class=ev>→ "+esc((byId[e.target]||{label:e.target}).label)+esc(edgeLabel(e))+"</span>"; }); }
   if(into.length){ h+="<br><span class=k>入边：</span>"; into.forEach(function(e){ h+="<span class=ev>← "+esc((byId[e.source]||{label:e.source}).label)+esc(edgeLabel(e))+"</span>"; }); }
   tip.innerHTML=h; tip.hidden=false; moveTip(ev);
 }
 function moveTip(ev){
   var r=stage.getBoundingClientRect();
   tip.style.left=(ev.clientX-r.left+14)+"px"; tip.style.top=(ev.clientY-r.top+14)+"px";
 }
 function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}

 // pan + zoom
 var tx=0,ty=0,scale=1,dragging=false,sx=0,sy=0;
 function xform(){ view.setAttribute("transform","translate("+tx+","+ty+") scale("+scale+")"); }
 stage.addEventListener("mousedown",function(ev){ if(ev.target.closest(".tg-node"))return; dragging=true;stage.classList.add("drag");sx=ev.clientX-tx;sy=ev.clientY-ty; });
 window.addEventListener("mousemove",function(ev){ if(!dragging)return; tx=ev.clientX-sx;ty=ev.clientY-ty;xform(); });
 window.addEventListener("mouseup",function(){ dragging=false;stage.classList.remove("drag"); });
 stage.addEventListener("wheel",function(ev){ ev.preventDefault(); var f=ev.deltaY<0?1.1:0.9; var ns=Math.max(0.2,Math.min(4,scale*f));
   var r=svg.getBoundingClientRect(); var mx=ev.clientX-r.left, my=ev.clientY-r.top;
   tx=mx-(mx-tx)*(ns/scale); ty=my-(my-ty)*(ns/scale); scale=ns; xform(); },{passive:false});
 apply();
})();
`;
