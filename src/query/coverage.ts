import type { ModelGraph } from "../loader/model-graph.js";
import {
  isGradedFlow,
  scenarioHasTestEvidence,
  scenarioTestAnchorLabels,
} from "../schema/model.js";
import { scenarioApplies } from "./effective-constraints.js";

/**
 * Model-side coverage: how much of the model is actually bound to something
 * checkable. This is the OPPOSITE direction from `reconcile`, which asks
 * "does the code contain a route/queue/poller the model forgot to register?"
 * — a whole-repo, code→model measure that reads near-100% on a model that
 * covers one flow, because unregistered facts are the only thing it can see.
 * Nothing in that number tells a reader how much of the MODEL is anchored,
 * so a report carrying only `reconcile` invites "96% — looks covered".
 *
 * Every count here is DIRECT attachment (`Loop.anchors`, `Loop.scenarios`,
 * `Junction.scenarios`). Resolving `applies_to` into the covered counts would
 * defeat the point: one `owner_match` invariant matches every loop whose free-text
 * `owner` contains the pattern, which silently flips large parts of the model to
 * "covered" without any loop-specific behavior being written down. That number is
 * still worth seeing, so it is reported on its own labelled line
 * (`loopsOnlyViaSelector`) and never folded into `loopsWithScenarios`.
 */
export interface FlowCoverage {
  id: string;
  title: string;
  /** Loops in `traverses` (guarded_by/references deliberately excluded — see computeCoverage). */
  loops: number;
  /** Of those, how many carry >=1 directly-attached scenario. */
  loopsWithScenarios: number;
  /**
   * Whether the flow itself carries a directly-attached anchor (F2a) — its OWN
   * claim, distinct from any anchor a traversed loop carries. This is the axis
   * `conformance`'s code check grades a flow on (conformance.ts's `gradeFlow`),
   * so a zero-loop flow (traverses empty) that is anchored this way is NOT the
   * same as an unbound flow — see `flowsWithAnchors` on `Coverage`.
   */
  hasOwnAnchor: boolean;
  /**
   * Whether the flow itself carries a directly-attached scenario (F2b), same
   * direct-attachment rule as `loopsWithScenarios` (not resolved via
   * `applies_to`) and the same axis conformance's `gradeFlow` test-checks.
   */
  hasOwnScenario: boolean;
}

export interface Coverage {
  loops: number;
  loopsWithAnchors: number;
  loopsWithScenarios: number;
  /**
   * Loops with no directly-attached scenario that are nonetheless selected by
   * some scenario's `applies_to`. Reported separately so query-time selection
   * can't masquerade as attached coverage — deliberately NOT split by selector
   * kind: `nodes` names a loop explicitly and `owner_match` sweeps a package,
   * but neither is written on the loop, which is the distinction this line draws.
   */
  loopsOnlyViaSelector: number;
  /**
   * Model files that failed to parse. Non-zero means every count here is a LOWER
   * BOUND on a partially-loaded graph — critically, it can move the reported
   * PERCENTAGES either way: dropping an unanchored loop shrinks the denominator
   * and makes coverage look better (measured: one broken file took 27/67=40% to
   * 26/57=46%). Silently reporting the higher number would make a command whose
   * whole purpose is to stop over-reading coverage do exactly that, so this is
   * surfaced in the output rather than left to `check` in the same job.
   */
  parseErrors: number;
  junctions: number;
  junctionsWithScenarios: number;
  scenarios: number;
  /** Scenarios with a non-empty `verified_by` (the rest are unverified by construction). */
  scenariosVerified: number;
  /** DISTINCT `verified_by` anchor strings — the real anti-rot surface, always <= the sum of references. */
  uniqueTestAnchors: number;
  /**
   * Flows `conformance` actually grades (`isGradedFlow`) — the denominator the
   * two counts below are reported over. Using ALL flows would leave coverage
   * and conformance disagreeing about the same model from the other side: a
   * model with 1 anchored flow and 9 composition-only ones would read 1/10
   * here while conformance grades exactly one flow and excludes nine.
   */
  gradedFlows: number;
  /**
   * Flows with >=1 directly-attached anchor of their OWN (F2a) — separate
   * denominator from `loopsWithAnchors`, and NOT folded into any `flows[].loops`
   * figure. This is what closes the disagreement `conformance` and `coverage`
   * used to have on a flow-shaped repo: `conformance`'s `gradeFlow` already
   * grades a flow on these same own anchors, so a zero-`traverses` flow that is
   * anchored this way is "covered" on both reports now, not just one (issue #16).
   */
  flowsWithAnchors: number;
  /** Flows with >=1 directly-attached scenario of their OWN (F2b) — see `flowsWithAnchors`. */
  flowsWithScenarios: number;
  flows: FlowCoverage[];
}

/**
 * Per-flow coverage counts only `traverses`. `guarded_by` holds watchdog loops
 * that cover a flow without sitting in its sequence, and `references` holds
 * sub-flows — folding either in would let C1's coverage leak into every flow
 * that C1 guards or references, which is precisely the "looks more covered than
 * it is" failure this command exists to prevent.
 *
 * A loop traversed by several flows counts toward each of them. That is
 * intentional: the question a flow row answers is "is THIS chain's behavior
 * written down", and a shared loop genuinely is written down for both.
 */
export function computeCoverage(graph: ModelGraph, parseErrors = 0): Coverage {
  const loops = [...graph.byKind.loop.values()];
  const junctions = [...graph.byKind.junction.values()];
  const scenarios = [...graph.byKind.scenario.values()];

  const loopHasScenario = new Map(loops.map((loop) => [loop.id, loop.scenarios.length > 0]));

  const anchors = new Set<string>();
  let scenariosVerified = 0;
  for (const scenario of scenarios) {
    // Both `verified_by` forms count: a scenario pinned to a test by TEXT is
    // as verified as one pinned by symbol (see schema `TestTextAnchor`), and
    // reading `verified_by` alone would report it as an unverified scenario.
    if (scenarioHasTestEvidence(scenario)) scenariosVerified += 1;
    for (const anchor of scenarioTestAnchorLabels(scenario)) anchors.add(anchor);
  }

  const loopsOnlyViaSelector = loops.filter(
    (loop) =>
      loop.scenarios.length === 0 &&
      scenarios.some((scenario) => scenarioApplies(scenario, loop.id, graph)),
  ).length;

  const flowNodes = [...graph.byKind.flow.values()];
  // The population `conformance` grades — the single source for every
  // conformance-aligned numerator AND denominator below.
  const gradedFlowNodes = flowNodes.filter((f) => isGradedFlow(f));
  const flows: FlowCoverage[] = flowNodes.map((flow) => ({
    id: flow.id,
    title: flow.title,
    loops: flow.traverses.length,
    // An id in `traverses` that resolves to no loop node is a dangling
    // reference — T0's job to flag, not ours. It counts toward `loops` (the
    // flow does claim to traverse it) but never toward covered, so a broken
    // reference can only ever depress coverage, never inflate it.
    loopsWithScenarios: flow.traverses.filter((id) => loopHasScenario.get(id) === true).length,
    // Own anchors/scenarios are a SEPARATE axis from the traverses-derived
    // fields above — never merged into `loops`/`loopsWithScenarios`, so a
    // flow's own binding can only ever ADD a fact for a reader to see, never
    // quietly inflate the traverses-based ratio (same "depress, never inflate"
    // property `loopsWithScenarios` already holds for dangling references).
    hasOwnAnchor: flow.anchors.length > 0,
    // Gated by the SAME `isGradedFlow` predicate `conformance` uses. On a
    // composition-only flow (composes something, carries no own anchor) T0
    // already warns that its `scenarios` are ignored and `computeConformance`
    // excludes the flow outright — counting them here would recreate exactly
    // the coverage↔conformance disagreement this field exists to close, only
    // pointing the other way, and would suppress the "no behavior modeled"
    // marker for a flow whose traversed loops carry no scenario at all.
    // `hasOwnAnchor` needs no gate: owning an anchor makes a flow `anchored`,
    // which is graded by definition.
    hasOwnScenario: flow.scenarios.length > 0 && isGradedFlow(flow),
  }));

  return {
    loops: loops.length,
    loopsWithAnchors: loops.filter((loop) => loop.anchors.length > 0).length,
    loopsWithScenarios: loops.filter((loop) => loop.scenarios.length > 0).length,
    loopsOnlyViaSelector,
    parseErrors,
    junctions: junctions.length,
    junctionsWithScenarios: junctions.filter((j) => j.scenarios.length > 0).length,
    scenarios: scenarios.length,
    scenariosVerified,
    uniqueTestAnchors: anchors.size,
    // All three come from the SAME filtered set. Taking the denominator from
    // graded flows while counting anchors over every flow lets the numerator
    // exceed it: a flow with an explicit `shape: composed` AND its own anchors
    // (a T0 error, but `coverage` keeps reporting and exits 0 on an invalid
    // model, so it cannot lean on another command failing) is excluded by
    // `isGradedFlow` yet still carries anchors — printing `1/0` or >100%.
    gradedFlows: gradedFlowNodes.length,
    flowsWithAnchors: gradedFlowNodes.filter((f) => f.anchors.length > 0).length,
    flowsWithScenarios: gradedFlowNodes.filter((f) => f.scenarios.length > 0).length,
    flows,
  };
}

function pct(n: number, total: number): string {
  if (total === 0) return "n/a";
  return `${Math.round((n / total) * 100)}%`;
}

/**
 * Plain-text report, one fact per line, shaped to drop into the same job
 * summary as `check`/`reconcile` output. Flows with zero covered loops are
 * listed explicitly rather than summarized as a count — "C4 会话复活: 0/3"
 * is the line that stops a reader assuming the whole model is anchored.
 * A flow's own anchor/scenario (F2a/F2b) is reported on the SAME line as its
 * traverses-derived ratio but never merged into it — see the `own` bracket
 * below — so a zero-loop, flow-shaped-repo flow (issue #16) reads as covered
 * without turning `X/Y` into a ratio nobody can reconstruct from the parts.
 */
export function formatCoverage(coverage: Coverage): string[] {
  const lines: string[] = [];

  // First line, not a footnote: a reader who stops after the headline number
  // must not walk away with a figure that a broken file silently moved.
  if (coverage.parseErrors > 0) {
    lines.push(
      `⚠ ${coverage.parseErrors} model file(s) failed to parse — every count below is a lower bound on a partial graph, and the percentages may read HIGHER than reality (run \`codeontic check\` for the ids)`,
    );
  }

  lines.push(
    `model coverage: ${coverage.loops} loop(s), ${coverage.junctions} junction(s), ${coverage.scenarios} scenario(s)`,
    `  loops with anchors:   ${coverage.loopsWithAnchors}/${coverage.loops} (${pct(coverage.loopsWithAnchors, coverage.loops)})`,
    `  loops with scenarios: ${coverage.loopsWithScenarios}/${coverage.loops} (${pct(coverage.loopsWithScenarios, coverage.loops)})`,
  );

  if (coverage.loopsOnlyViaSelector > 0) {
    lines.push(
      `  (+ ${coverage.loopsOnlyViaSelector} loop(s) selected only via an applies_to selector — resolved at query time, not attached to the loop)`,
    );
  }

  lines.push(
    `  junctions with scenarios: ${coverage.junctionsWithScenarios}/${coverage.junctions}`,
    `  scenarios verified_by:    ${coverage.scenariosVerified}/${coverage.scenarios}, ${coverage.uniqueTestAnchors} distinct test anchor(s)`,
  );

  if (coverage.flows.length > 0) {
    lines.push(
      // Denominator is GRADED flows, matching conformance. Excluded flows are
      // printed on the same line rather than silently dropped from the
      // denominator — a shrinking denominator with no stated reason is the
      // "a number that won't say why it is that number" failure this repo
      // keeps having to fix.
      `  flows with own anchors:   ${coverage.flowsWithAnchors}/${coverage.gradedFlows} (${pct(coverage.flowsWithAnchors, coverage.gradedFlows)})`,
      `  flows with own scenarios: ${coverage.flowsWithScenarios}/${coverage.gradedFlows} (${pct(coverage.flowsWithScenarios, coverage.gradedFlows)})`,
      `  (${coverage.flows.length - coverage.gradedFlows} composition-only flow(s) excluded from those two, same as conformance)`,
    );
    lines.push(
      "  per-flow (traversed loops with >=1 scenario; [own: ...] shown when the flow itself carries F2a/F2b):",
    );
    for (const flow of coverage.flows) {
      // Uncovered means neither side carries behavior: no traversed loop has a
      // scenario AND the flow has no scenario of its own. A zero-`traverses`
      // flow (loops=0) that IS covered via its own scenario must NOT be marked
      // — that is exactly the flow-shaped-repo case issue #16 exists to fix.
      const uncovered = flow.loopsWithScenarios === 0 && !flow.hasOwnScenario;
      const mark = uncovered ? " ← no behavior modeled" : "";
      // The traverses-based ratio never absorbs the own-anchor/scenario facts
      // (no shared denominator to divide wrong by — see the #35 postmortem on
      // self-contradictory summary math); own coverage is reported as a
      // separate bracket instead, and only when the flow actually declares it.
      const own =
        flow.hasOwnAnchor || flow.hasOwnScenario
          ? ` [own: anchor${flow.hasOwnAnchor ? "✓" : "✗"} scenario${flow.hasOwnScenario ? "✓" : "✗"}]`
          : "";
      lines.push(
        `    ${flow.id} ${flow.title}: ${flow.loopsWithScenarios}/${flow.loops}${own}${mark}`,
      );
    }
  }

  return lines;
}
