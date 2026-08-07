import type { ModelGraph } from "../loader/model-graph.js";
import type { Flow, Junction, Loop, Scenario, TestTextAnchor } from "../schema/index.js";
import { isGradedFlow, scenarioHasTestEvidence, testTextAnchorLabel } from "../schema/model.js";
import { anchorFilePath } from "../validate/anchor.js";
import { collectAnchorStrings } from "../validate/checks.js";

/**
 * Implementation conformance: a MODEL→CODE report card. `coverage` asks how
 * much of the model is bound to anything checkable (a model self-audit);
 * `reconcile` asks what the code contains that the model forgot (code→model).
 * This third view holds the model up as the acceptance checklist and asks, per
 * node, "does the implementation measure up — is the declared behavior anchored
 * in real code and guarded by a real test, and where are the gaps?".
 *
 * The direction of authority never inverts: a gap is a debt the IMPLEMENTATION
 * owes the model, not a mark against the model's credibility. When the model
 * declares a boundary/queue/junction the code can't be shown to satisfy, that
 * is a code/test gap — the model stays the source of truth (001 §2 三分离;
 * the whole reason codeontic can catch drift a descriptive code-graph can't).
 *
 * Like `coverage`, this counts only DIRECTLY-attached scenarios (Loop.scenarios,
 * Junction.scenarios). `applies_to`-selected scenarios are resolved at query
 * time and not written on the node, so folding them in would let one
 * cross-cutting invariant flip large parts of the model to "met" without any
 * node-specific test being written — exactly the over-report coverage.ts guards
 * against. Zero LLM, zero network, zero code execution: anchor/test resolution
 * is file existence PLUS symbol/text presence (exactly `checkAnchorExistence`'s
 * fidelity, from the same module — see presence.ts and `staleAnchors` below),
 * and queue matching is name set-membership over already-extracted facts.
 */

export type ConformanceVerdict = "met" | "partial" | "gap";

/**
 * Every gap is defined BY THE MODEL — it names a declared obligation the
 * implementation side can't be shown to satisfy:
 * - `no-anchor`      loop declares behavior but no code anchor binds it
 * - `anchor-missing` an anchor's file does not exist under the repo (repo-resolved only)
 * - `anchor-stale`   every anchor's file exists but none still names its symbol (repo-resolved only)
 * - `no-scenario`    node's behavior/risk is not pinned to any GWT scenario (unguarded)
 * - `scenario-unverified` an attached scenario has no `verified_by` test
 * - `test-missing`   a `verified_by` test file does not exist under the repo (repo-resolved only)
 * - `test-stale`     a `verified_by` test file exists but no longer names the test (repo-resolved only)
 * - `queue-unmatched` a declared `consumes_queues` name matched no extracted fact (adapter only)
 * - `evidence-missing` a junction evidence anchor's file does not exist under the repo (repo-resolved only)
 */
export type GapKind =
  | "no-anchor"
  | "anchor-missing"
  | "anchor-stale"
  | "no-scenario"
  | "scenario-unverified"
  | "test-missing"
  | "test-stale"
  | "queue-unmatched"
  | "evidence-missing";

export interface Gap {
  nodeId: string;
  nodeKind: "loop" | "junction" | "flow";
  kind: GapKind;
  /** Which anchor / queue / scenario is missing — the actionable pointer. */
  detail: string;
}

/** "present"/"missing" are structural unless `repoResolved`, when they also mean the file exists. */
export type AxisStatus = "present" | "missing";

export interface NodeConformance {
  id: string;
  kind: "loop" | "junction" | "flow";
  title: string;
  verdict: ConformanceVerdict;
  /** implementation anchored (and, when repo-resolved, the anchor file exists). */
  code: AxisStatus;
  /** behavior guarded by a verified scenario (and, when repo-resolved, its test file exists). */
  test: AxisStatus;
  /**
   * Distinct `level`s of the scenarios that actually counted toward the test
   * axis, sorted. Reported, NOT judged (Proposal 016 D9): `test✓` today cannot
   * tell a unit test CI runs on every push from an e2e script that needs an API
   * key and a live provider, and a reader deciding how much to trust a green
   * node deserves to see which it is. Turning level into a grading input needs
   * a policy nobody has agreed on yet; showing the evidence needs nothing.
   */
  testLevels: string[];
  gaps: Gap[];
}

export interface Conformance {
  nodes: NodeConformance[];
  /** Every node's gaps, flattened — the punch-list. */
  gaps: Gap[];
  counts: { met: number; partial: number; gap: number };
  /**
   * Non-dormant loops + all junctions + flows that carry their OWN code binding
   * are graded; dormant loops and composition-only flows are excluded and only
   * counted (see `dormantExcluded` / `flowsExcluded`).
   */
  graded: number;
  dormantExcluded: number;
  /**
   * Flows excluded from grading because they compose other model nodes
   * (`traverses`/`references`/…) and carry no own anchors: their constituent
   * loops are already graded, so grading the flow "met" would double-count that
   * green and inflate the headline (the same over-report `applies_to` scenarios
   * are kept out of grading to avoid). Counted, never silently dropped.
   */
  flowsExcluded: number;
  /**
   * Whether anchor/test FILE existence was actually checked (a repo root was
   * supplied). When false, `present`/`missing` are STRUCTURAL — a `met` means
   * "declared", not "verified against code" — and no *-missing gaps are emitted.
   */
  repoResolved: boolean;
  /**
   * How many DISTINCT repo files the whole model anchors into (`=
   * anchorFilesToResolve(graph).length`). Reported at the top of the report as
   * a SEARCH-THOROUGHNESS proxy, never as business completeness (Proposal 016
   * T5): it says how much of the codebase the modelling pass actually touched,
   * so a 3-file model can no longer present itself as a system map with the
   * same voice as a 96-file one. The real completeness question — which
   * behaviours were missed — has no machine-computable denominator.
   */
  anchoredFileCount: number;
  /** Whether an adapter was available to extract queue facts (else queue gaps are skipped). */
  queueChecked: boolean;
  /** How many `consumes_queues` obligations the graded loops declare (for the skip note). */
  declaredQueueCount: number;
  parseErrors: number;
}

export interface ConformanceInputs {
  /**
   * Repo-relative file paths that EXIST under the repo root. `undefined` ⇒ no
   * repo root given: file existence is not checked and declared anchors/tests
   * are trusted structurally (see `repoResolved`). Authoritative when present:
   * a file computed here but absent from the set is treated as missing, so the
   * caller MUST have stat'd every file `anchorFilesToResolve` returns.
   */
  existingFiles?: Set<string>;
  /**
   * Anchors whose FILE exists but which no longer name anything in it —
   * `AnchorPresence.staleSymbolAnchors` ∪ `staleTextAnchors`, keyed by the
   * anchor string (symbol form) or `testTextAnchorLabel` (text form).
   *
   * This is the P0 fix of Proposal 016 T6/D1. Before it, a renamed symbol left
   * the score untouched — `check` warned, the report card said `met code✓
   * test✓`, and on a real target the model's only `met` node stood on five
   * test anchors that named nothing in their files. `undefined` ⇒ not computed
   * (no repo root): nothing is stale, same posture as `existingFiles`.
   *
   * NOT symmetrical with `existingFiles`, and the asymmetry is the point:
   * a missing file is a hard fact, while "the file no longer mentions this
   * name" is whole-word text matching (symbol.ts) that a legitimate refactor
   * can trip. So a stale anchor never fails the gate (`check` keeps it a
   * warning) and downgrades the CODE axis only when EVERY anchor on the node
   * is stale — one stale anchor among eight still leaves the node bound to
   * real code. On the TEST axis a stale anchor does disqualify its scenario,
   * because each `verified_by` entry is a separate claim that a specific test
   * covers this behaviour, and a claim that points at nothing is not evidence.
   */
  staleAnchors?: Set<string>;
  /**
   * Names of extracted queue facts (`ImplementationFact.name` for the adapter's
   * name-matchable signal kinds). `undefined` ⇒ no adapter: queue matching is
   * skipped (not treated as all-missing — an absent adapter is not a gap).
   */
  queueFactNames?: Set<string>;
}

/**
 * Every repo-relative file path this computation will test for existence, as a
 * VIEW over the same two enumerations the CLI resolves (`collectAnchorStrings`
 * + `textAnchorsToResolve`) — not a third hand-maintained list of anchor-
 * bearing fields.
 *
 * It used to be that list, and the drift it invites is not hypothetical: the
 * caller must stat exactly the files this computation asks about, or an anchor
 * it forgot reads as `anchor-missing` on every repo-resolved run — a fabricated
 * gap on a node that is perfectly fine. Deriving both from one enumeration is
 * the same 派生判断只定义一处 rule that made `check` and `conformance` share
 * presence.ts in the first place. Table-style anchors (no `#`) have no file and
 * are excluded — like `checkAnchorExistence`, never resolved, never a gap.
 */
export function anchorFilesToResolve(graph: ModelGraph): string[] {
  const files = new Set<string>();
  for (const anchor of collectAnchorStrings(graph)) {
    const f = anchorFilePath(anchor);
    if (f) files.add(f);
  }
  // Text-form test anchors carry their file directly (no `#` to split on).
  for (const t of textAnchorsToResolve(graph)) files.add(t.file);
  return [...files].sort();
}

/** Every `{file, text}` test anchor in the graph — the text half of `verified_by`. */
export function textAnchorsToResolve(graph: ModelGraph): TestTextAnchor[] {
  return [...graph.byKind.scenario.values()].flatMap((s) => s.verified_by_text);
}

/**
 * A file-symbol anchor's file resolves. When `existingFiles` is undefined
 * (no repo root) resolution is not attempted and the anchor is trusted. Table
 * anchors (no file part) always "resolve" — there is no file to check.
 */
function anchorResolves(anchor: string, existingFiles: Set<string> | undefined): boolean {
  if (!existingFiles) return true;
  const file = anchorFilePath(anchor);
  if (file === undefined) return true; // table anchor — nothing to verify
  return existingFiles.has(file);
}

/** The anchor's file exists but the symbol/text it names is gone (see `staleAnchors`). */
function anchorIsStale(anchor: string, inputs: ConformanceInputs): boolean {
  return inputs.staleAnchors?.has(anchor) === true;
}

/**
 * The CODE axis's stale rule, shared by loop / flow / junction so the three can
 * never drift: an anchor set is discredited only when EVERY resolvable anchor
 * in it went stale. See `ConformanceInputs.staleAnchors` for why unanimity —
 * one stale name among many still leaves the node bound to real code, and this
 * tier's evidence is text matching, not an AST.
 */
function allAnchorsStale(anchors: string[], inputs: ConformanceInputs): boolean {
  if (!inputs.staleAnchors || anchors.length === 0) return false;
  return anchors.every((a) => anchorIsStale(a, inputs));
}

function gradeLoop(loop: Loop, graph: ModelGraph, inputs: ConformanceInputs): NodeConformance {
  const gaps: Gap[] = [];
  const push = (kind: GapKind, detail: string) =>
    gaps.push({ nodeId: loop.id, nodeKind: "loop", kind, detail });

  // --- code axis: is the declared behavior anchored in real code? ---
  let code: AxisStatus;
  if (loop.anchors.length === 0) {
    code = "missing";
    push("no-anchor", "loop declares behavior but carries no code anchor");
  } else {
    const unresolved = loop.anchors.filter((a) => !anchorResolves(a, inputs.existingFiles));
    if (unresolved.length > 0) {
      code = "missing";
      for (const a of unresolved)
        push("anchor-missing", `anchor "${a}" points at a file that does not exist`);
    } else if (allAnchorsStale(loop.anchors, inputs)) {
      code = "missing";
      for (const a of loop.anchors)
        push("anchor-stale", `anchor "${a}" names a symbol its file no longer contains`);
    } else {
      code = "present";
    }
  }

  // --- test axis: is the behavior guarded by a verified scenario? ---
  const { status: test, levels: testLevels } = gradeScenarioAttachment(
    loop.id,
    "loop",
    loop.scenarios,
    graph,
    inputs,
    gaps,
  );

  // --- queue obligations: declared consumers must match an extracted fact. ---
  let queueOk = true;
  if (inputs.queueFactNames) {
    for (const q of loop.consumes_queues) {
      if (!inputs.queueFactNames.has(q)) {
        queueOk = false;
        push("queue-unmatched", `consumes_queues "${q}" matches no extracted queue fact`);
      }
    }
  }

  const verdict: ConformanceVerdict =
    code === "missing" ? "gap" : test === "present" && queueOk ? "met" : "partial";

  return { id: loop.id, kind: "loop", title: loop.title, verdict, code, test, testLevels, gaps };
}

function gradeJunction(j: Junction, graph: ModelGraph, inputs: ConformanceInputs): NodeConformance {
  const gaps: Gap[] = [];
  const push = (kind: GapKind, detail: string) =>
    gaps.push({ nodeId: j.id, nodeKind: "junction", kind, detail });

  // --- code axis: do the junction's evidence anchors resolve? ---
  // A junction with no evidence is not itself a defect (its `between` still
  // ties two real loops); only an evidence anchor that points nowhere is.
  let code: AxisStatus = "present";
  const unresolved = j.evidence.filter((e) => !anchorResolves(e.anchor, inputs.existingFiles));
  const evidenceAnchors = j.evidence.map((e) => e.anchor);
  if (unresolved.length > 0) {
    code = "missing";
    for (const e of unresolved)
      push("evidence-missing", `evidence "${e.anchor}" points at a file that does not exist`);
  } else if (allAnchorsStale(evidenceAnchors, inputs)) {
    // Same unanimous rule as a loop's own anchors — evidence is this node's
    // code axis, and a junction whose every pointer went stale must not keep
    // reading `code✓` just because the files are still there.
    code = "missing";
    for (const a of evidenceAnchors)
      push("anchor-stale", `evidence "${a}" names a symbol its file no longer contains`);
  }

  // --- test axis: is this risk point guarded by a verified scenario? ---
  const { status: test, levels: testLevels } = gradeScenarioAttachment(
    j.id,
    "junction",
    j.scenarios,
    graph,
    inputs,
    gaps,
  );

  // An UNGUARDED junction (no scenario at all) is the headline thing this view
  // exists to surface, so it is a `gap`, not a `partial` — a modeled cross-loop
  // risk with no test standing over it is the sharpest kind of implementation
  // debt. A missing evidence anchor is likewise a `gap`.
  const unguarded = j.scenarios.length === 0;
  const verdict: ConformanceVerdict =
    code === "missing" || unguarded ? "gap" : test === "present" ? "met" : "partial";

  const title = j.title ?? j.id;
  return { id: j.id, kind: "junction", title, verdict, code, test, testLevels, gaps };
}

/**
 * Grade a flow on both axes — code (own anchors) and test (own scenarios, F2b),
 * the same shape loops are graded on. A code-anchored flow with no verified
 * scenario is `partial`, NOT `met`: anchored ≠ tested. The code axis dominates —
 * a flow with no anchors is a `gap` even if it carries a passing scenario, because
 * a test pointing elsewhere does not rescue an unbound implementation claim.
 *
 * Reached for exactly two cases, both of which SHOULD be graded:
 *   1. the flow declares its OWN anchors — graded on those, EVEN IF it also
 *      composes (`references`/`traverses`); the anchors are the flow's own
 *      contribution (e.g. an update flow's update-specific glue), distinct from
 *      its composed parts, so this is not double-counting;
 *   2. the flow declares no anchors AND composes nothing — genuinely unbound, a
 *      `no-anchor` gap.
 * The ONE case filtered out upstream in `computeConformance` is "no own anchors
 * but composes": there the flow's implementation IS its composed nodes (already
 * graded), so grading it would double-count their green.
 */
function gradeFlow(flow: Flow, graph: ModelGraph, inputs: ConformanceInputs): NodeConformance {
  const gaps: Gap[] = [];
  const push = (kind: GapKind, detail: string) =>
    gaps.push({ nodeId: flow.id, nodeKind: "flow", kind, detail });

  // --- code axis: is the flow's journey anchored in real code? ---
  let code: AxisStatus;
  if (flow.anchors.length === 0) {
    code = "missing";
    push("no-anchor", "flow composes no model node and carries no code anchor");
  } else {
    const unresolved = flow.anchors.filter((a) => !anchorResolves(a, inputs.existingFiles));
    if (unresolved.length > 0) {
      code = "missing";
      for (const a of unresolved)
        push("anchor-missing", `anchor "${a}" points at a file that does not exist`);
    } else if (allAnchorsStale(flow.anchors, inputs)) {
      code = "missing";
      for (const a of flow.anchors)
        push("anchor-stale", `anchor "${a}" names a symbol its file no longer contains`);
    } else {
      code = "present";
    }
  }

  // --- test axis: is the journey guarded by a verified scenario? (F2b) ---
  const { status: test, levels: testLevels } = gradeScenarioAttachment(
    flow.id,
    "flow",
    flow.scenarios,
    graph,
    inputs,
    gaps,
  );

  const verdict: ConformanceVerdict =
    code === "missing" ? "gap" : test === "present" ? "met" : "partial";
  return { id: flow.id, kind: "flow", title: flow.title, verdict, code, test, testLevels, gaps };
}

/**
 * Shared test-axis grading for a node's directly-attached scenarios. Emits
 * `no-scenario` / `scenario-unverified` / `test-missing` / `test-stale` gaps
 * and returns whether the behavior is fully guarded, plus the levels of the
 * scenarios that actually counted (see `NodeConformance.testLevels`). A
 * scenario id that resolves to no node is treated as unverified (T0's
 * referential-integrity check fails the build on it separately — here we must
 * not crash and must not silently pass).
 */
function gradeScenarioAttachment(
  nodeId: string,
  nodeKind: "loop" | "junction" | "flow",
  scenarioIds: string[],
  graph: ModelGraph,
  inputs: ConformanceInputs,
  gaps: Gap[],
): { status: AxisStatus; levels: string[] } {
  const push = (kind: GapKind, detail: string) => gaps.push({ nodeId, nodeKind, kind, detail });

  if (scenarioIds.length === 0) {
    push("no-scenario", "behavior is not pinned to any GWT scenario");
    return { status: "missing", levels: [] };
  }

  let fullyGuarded = true;
  const levels = new Set<string>();
  for (const id of scenarioIds) {
    const scenario = graph.byKind.scenario.get(id);
    if (!scenario) {
      fullyGuarded = false;
      push("scenario-unverified", `scenario "${id}" is not a defined scenario`);
      continue;
    }
    if (!scenarioHasTestEvidence(scenario)) {
      fullyGuarded = false;
      push("scenario-unverified", `scenario "${id}" has no verified_by test`);
      continue;
    }
    if (gradeScenarioTests(scenario, inputs, push)) levels.add(scenario.level);
    else fullyGuarded = false;
  }
  return { status: fullyGuarded ? "present" : "missing", levels: [...levels].sort() };
}

/**
 * Does every test anchor on this scenario still point at something real? Both
 * `verified_by` forms are checked the same way and to the same standard: the
 * file must exist, and (repo-resolved) the symbol/text must still be in it.
 *
 * ANY stale or missing anchor disqualifies the scenario — unlike the code axis
 * (see `allAnchorsStale`), where unanimity is required. The two are different
 * claims: a node's anchors jointly say "the implementation is here", so one
 * stale name leaves the claim standing; each `verified_by` entry separately
 * says "this specific test covers this behaviour", and an entry naming a test
 * that no longer exists is not evidence of anything. This is also the
 * pre-existing `test-missing` posture, kept rather than reinvented.
 */
function gradeScenarioTests(
  scenario: Scenario,
  inputs: ConformanceInputs,
  push: (kind: GapKind, detail: string) => void,
): boolean {
  let intact = true;
  for (const vb of scenario.verified_by) {
    if (!anchorResolves(vb, inputs.existingFiles)) {
      intact = false;
      push(
        "test-missing",
        `scenario "${scenario.id}" test "${vb}" points at a file that does not exist`,
      );
    } else if (anchorIsStale(vb, inputs)) {
      intact = false;
      push("test-stale", `scenario "${scenario.id}" test anchor stale: ${vb}`);
    }
  }
  for (const vb of scenario.verified_by_text) {
    const label = testTextAnchorLabel(vb);
    if (inputs.existingFiles && !inputs.existingFiles.has(vb.file)) {
      intact = false;
      push(
        "test-missing",
        `scenario "${scenario.id}" test ${label} points at a file that does not exist`,
      );
    } else if (anchorIsStale(label, inputs)) {
      intact = false;
      push("test-stale", `scenario "${scenario.id}" test anchor stale: ${label}`);
    }
  }
  return intact;
}

/**
 * Grade every non-dormant Loop and every Junction against the code/test the
 * model declares. Dormant loops (N-series baseline placeholders — owner-null,
 * unwired) are NOT graded: they exist to quiet reconcile's advisory signal, not
 * to assert modeled behavior, so grading them would manufacture gaps for
 * something deliberately left unimplemented. They are counted in
 * `dormantExcluded` so the exclusion is visible, never silent (001 §12).
 */
export function computeConformance(
  graph: ModelGraph,
  inputs: ConformanceInputs = {},
  parseErrors = 0,
): Conformance {
  const nodes: NodeConformance[] = [];
  let dormantExcluded = 0;
  let flowsExcluded = 0;
  let declaredQueueCount = 0;

  for (const loop of graph.byKind.loop.values()) {
    if (loop.dormant) {
      dormantExcluded += 1;
      continue;
    }
    declaredQueueCount += loop.consumes_queues.length;
    nodes.push(gradeLoop(loop, graph, inputs));
  }
  for (const j of graph.byKind.junction.values()) {
    nodes.push(gradeJunction(j, graph, inputs));
  }
  for (const flow of graph.byKind.flow.values()) {
    // The grading gate is `isGradedFlow` (schema/model.ts) — the single
    // definition every consumer shares, so this decision and the views that
    // render it can no longer drift apart. See that function for why a
    // composition-only flow is excluded rather than graded.
    //
    // NOTE: a composition-only flow that carries its OWN `scenarios` is still
    // excluded and those scenarios do nothing. That is not silent — T0's
    // `flow-scenario-ignored` warns on exactly this case. Whether own-scenarios
    // should opt a flow in symmetrically with own-anchors is the open question
    // in Proposal 012 §2.2, deliberately not settled here.
    if (!isGradedFlow(flow)) {
      flowsExcluded += 1;
      continue;
    }
    nodes.push(gradeFlow(flow, graph, inputs));
  }

  const counts = { met: 0, partial: 0, gap: 0 };
  for (const n of nodes) counts[n.verdict] += 1;

  return {
    nodes,
    gaps: nodes.flatMap((n) => n.gaps),
    counts,
    graded: nodes.length,
    dormantExcluded,
    flowsExcluded,
    repoResolved: inputs.existingFiles !== undefined,
    anchoredFileCount: anchorFilesToResolve(graph).length,
    queueChecked: inputs.queueFactNames !== undefined,
    declaredQueueCount,
    parseErrors,
  };
}

const VERDICT_RANK: Record<ConformanceVerdict, number> = { gap: 0, partial: 1, met: 2 };
const VERDICT_MARK: Record<ConformanceVerdict, string> = { gap: "✗", partial: "◐", met: "✓" };

const GAP_LABEL: Record<GapKind, string> = {
  "no-anchor": "no code anchor",
  "anchor-missing": "anchor file missing",
  "anchor-stale": "anchor symbol gone",
  "no-scenario": "unguarded (no scenario)",
  "scenario-unverified": "scenario has no test",
  "test-missing": "test file missing",
  "test-stale": "test anchor stale",
  "queue-unmatched": "queue not found in code",
  "evidence-missing": "evidence file missing",
};

/**
 * Execution strength of the evidence behind a `test✓`, appended to it as
 * `test✓ [unit,integration]` (Proposal 016 D9). `(e2e-only evidence)` is added
 * when EVERY counted level is `e2e` — the case worth calling out, because an
 * e2e suite is the one that most often needs credentials or a live service and
 * so is the one least likely to have actually run before someone read this
 * score. `operational` is deliberately NOT folded in: it describes a different
 * thing (a runbook/alert-level check), and lumping the two would make the note
 * mean "not a unit test", which is not a claim worth printing.
 */
function formatTestLevels(levels: string[]): string {
  if (levels.length === 0) return "";
  const e2eOnly = levels.every((l) => l === "e2e");
  return ` [${levels.join(",")}]${e2eOnly ? " (e2e-only evidence)" : ""}`;
}

/**
 * Plain-text report, shaped to drop into the same job summary as
 * `check`/`coverage`. Leads with the honesty banners (parse errors, unresolved
 * mode) for the same reason coverage does — a reader who stops at the headline
 * must not walk away with a number that a broken file or an unresolved run
 * silently inflated. Graded nodes are listed worst-first; the gap punch-list is
 * the actionable tail.
 */
export function formatConformance(c: Conformance): string[] {
  const lines: string[] = [];

  if (c.parseErrors > 0) {
    lines.push(
      `⚠ ${c.parseErrors} model file(s) failed to parse — every node below is a lower bound on a partial graph (run \`codeontic check\` for the ids)`,
    );
  }
  if (!c.repoResolved) {
    lines.push(
      "⚠ implementation NOT resolved against code (no --repo-root) — a 'met' here means DECLARED, not verified; pass --repo-root <repo> to confirm anchors/tests exist on disk",
    );
  }
  if (!c.queueChecked && c.declaredQueueCount > 0) {
    lines.push(
      `⚠ ${c.declaredQueueCount} consumes_queues obligation(s) NOT checked (no adapter) — pass --adapter-path to verify declared queues exist in code`,
    );
  }

  // Coverage declaration (Proposal 016 T5), immediately above the score and
  // below the honesty banners: the banners say the numbers may be wrong, this
  // says how much of the repo they are about at all. Repo-resolved only —
  // without a checkout the count is a model-side fact with nothing to be a
  // fraction OF, and printing it would read as coverage when it is not.
  if (c.repoResolved) {
    lines.push(
      `model anchors reach ${c.anchoredFileCount} distinct repo file(s) — a SEARCH-THOROUGHNESS proxy (how much code the modelling pass touched), NOT business completeness: no machine can tell you which behaviors were never modeled`,
    );
  }

  const dormantNote =
    c.dormantExcluded > 0 ? `, ${c.dormantExcluded} dormant loop(s) excluded` : "";
  const flowExclNote =
    c.flowsExcluded > 0 ? `, ${c.flowsExcluded} composition-only flow(s) excluded` : "";
  lines.push(
    `conformance: ${c.counts.met} met / ${c.counts.partial} partial / ${c.counts.gap} gap (of ${c.graded} graded node(s))${dormantNote}${flowExclNote}`,
  );

  const sorted = [...c.nodes].sort(
    (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.id.localeCompare(b.id),
  );
  for (const n of sorted) {
    const code = n.code === "present" ? "code✓" : "code✗";
    const test = `${n.test === "present" ? "test✓" : "test✗"}${formatTestLevels(n.testLevels)}`;
    const gapNote =
      n.gaps.length > 0 ? `  (${n.gaps.length} gap${n.gaps.length > 1 ? "s" : ""})` : "";
    lines.push(
      `  ${VERDICT_MARK[n.verdict]} ${n.id} ${n.title}: ${n.verdict}  ${code} ${test}${gapNote}`,
    );
  }

  if (c.gaps.length > 0) {
    lines.push(`  gaps (${c.gaps.length}):`);
    for (const g of c.gaps) {
      lines.push(`    ${g.nodeId} — ${GAP_LABEL[g.kind]}: ${g.detail}`);
    }
  }

  return lines;
}
