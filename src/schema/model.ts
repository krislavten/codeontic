import { z } from "zod";
import { ConsistencyStatus, DebtCategory, RiskClass } from "./status.js";

/**
 * IDs are re-used verbatim from the source research documents so that the
 * drift test (test/drift.test.ts) can diff model IDs against IDs extracted
 * straight out of the PR tables, with no hand-maintained translation layer.
 */
export const LoopId = z
  .string()
  .regex(/^[LN]\d{1,2}[a-z]?$/, "loop id must look like L1, L1a, N32, etc.");
export type LoopId = z.infer<typeof LoopId>;

// C1.. with no upper bound: the original /^C\d$/ capped a model at 9 flows,
// which fit "a few trunk journeys" but not a CLI modeled one flow per command
// (Proposal 012 §2.3).
export const FlowId = z.string().regex(/^C\d+$/, "flow id must look like C1, C2, ... C42");
export type FlowId = z.infer<typeof FlowId>;

export const FeatureId = z.string().regex(/^F-[a-z0-9-]+$/, "feature id must look like F-xxx");
export type FeatureId = z.infer<typeof FeatureId>;

export const JunctionId = z.string().regex(/^J-[a-z0-9_-]+$/, "junction id must look like J-xxx");
export type JunctionId = z.infer<typeof JunctionId>;

export const ScenarioId = z
  .string()
  .regex(/^GWT-[A-Za-z0-9]+-\d{3}$/, "scenario id must look like GWT-<flow|loop>-001");
export type ScenarioId = z.infer<typeof ScenarioId>;

/**
 * Max length of `Evidence.note`. `note` exists only to help a reader
 * *locate* the anchored evidence (a line range, a function name, a test-name
 * fragment) — NOT to narrate causal reasoning or historical background.
 * The cap is a mechanical backstop for that intent: prose explanations run
 * long, pointers stay short. Kept as a named const so the schema test and
 * any future review tooling reference the same number.
 */
export const EVIDENCE_NOTE_MAX = 200;

/**
 * Max lines in a `Crux.text` fragment (Proposal 013 B2, aligned with Graft's
 * MAX_CRUX_LINES). A crux captures a SHORT behavioural snippet — enough to
 * identify the concern, not to reproduce the implementation.
 */
export const CRUX_MAX_LINES = 12;

/**
 * Max characters in a `Crux.text` fragment. Works alongside CRUX_MAX_LINES
 * as an absolute cap — 12 very long lines could still be unwieldy.
 */
export const CRUX_MAX_CHARS = 1200;

/**
 * A crux text anchor (Proposal 013 B2): a verbatim code snippet pinned to
 * an existing anchor, capturing specific behaviour that `path#symbol` is too
 * coarse to express. `text` is the source of truth — the exact code fragment;
 * line numbers are never stored because they rot on every edit.
 *
 * The `anchor` field MUST reference one of the owning node's `anchors` entries
 * (a crux is a refinement of an existing anchor, not a third anchor form).
 */
export const Crux = z.object({
  anchor: z.string().min(1),
  text: z
    .string()
    .min(1)
    .refine((t) => t.split("\n").length <= CRUX_MAX_LINES, {
      message: `crux text must be ≤${CRUX_MAX_LINES} lines`,
    })
    .refine((t) => t.length <= CRUX_MAX_CHARS, {
      message: `crux text must be ≤${CRUX_MAX_CHARS} characters`,
    }),
  note: z.string().max(EVIDENCE_NOTE_MAX).optional(),
});
export type Crux = z.infer<typeof Crux>;

/**
 * Evidence is embedded inside Junction (evidence: Evidence[]) rather than
 * a standalone top-level file — it only makes sense bound to the claim it
 * proves. Scenario does NOT carry Evidence directly: its `verified_by`
 * field holds plain test/E2E anchor strings instead, since GWT→test
 * binding is a simpler 1:many mapping than Junction's need for typed,
 * multi-kind evidence.
 *
 * `kind` taxonomy:
 * - Runtime/code evidence: test / durable_event / e2e / metric / trace /
 *   log / code — an anchor that resolves to a projection or observation of
 *   the running system.
 * - Intent/planning evidence (Proposal 006 A1): `spec` points at a
 *   requirement/design statement (a spec section, an ADR line), `issue`
 *   points at a tracked work item (a GitHub issue/PR reference). These let
 *   a junction cite "this handoff is deliberately deferred, see #NNNN" or
 *   "the poller's settled≠done semantics is specified here" without dressing
 *   a planning pointer up as a runtime observation. Because they are the
 *   easiest kind to smuggle prose into, `note` on these is held to the same
 *   anchor-only, pointer-not-narrative discipline as every other kind (see
 *   `EVIDENCE_NOTE_MAX`); reviewers of any content PR treat a `spec`/`issue`
 *   note that argues causation or recounts history as a defect.
 */
export const Evidence = z.object({
  id: z.string().min(1),
  kind: z.enum(["test", "durable_event", "e2e", "metric", "trace", "log", "code", "spec", "issue"]),
  anchor: z.string().min(1),
  source: z.string().optional(),
  transport: z.enum(["direct", "relay", "durable_event"]).optional(),
  binding: z
    .object({
      image_revision: z.enum(["required", "optional"]),
    })
    .optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  // Anchor-locating aid only (line range / function name / test-name
  // fragment). No causal reasoning, no historical background — long prose
  // belongs in the source doc the `spec`/`issue` anchor points at, not here.
  note: z.string().max(EVIDENCE_NOTE_MAX).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * Loop covers both ordinary top-level loops (L1, N19, ...) and the
 * "(内嵌)" embedded submachines (L1a/L1b/L3a/L20a) that share a parent's
 * boundary but carry their own state. Dormant/unwired loops like N8
 * ("M2 休眠") have owner: null and dormant: true instead of being dropped.
 */
export const Loop = z.object({
  id: LoopId,
  kind: z.literal("loop"),
  title: z.string().min(1),
  boundary: z.string().min(1),
  owner: z.string().min(1).nullable(),
  section: z.string().optional(),
  parent: LoopId.optional(),
  embedded: z.boolean().optional(),
  dormant: z.boolean().optional(),
  status: ConsistencyStatus.default("unverified"),
  anchors: z.array(z.string()).default([]),
  /**
   * What DRIVES this loop forward, declared so it can be checked against the
   * code rather than taken on faith: "poller" (a timer), "queue" (a consumer).
   *
   * OPTIONAL, and absent means unchecked — existing models keep validating
   * untouched. Declaring it opts the loop into `checkLoopMechanism`, which
   * asserts a matching fact actually exists in the files this loop anchors.
   * That is the one tier able to catch behaviour that MOVED while the anchor
   * kept pointing at a surviving wrapper (a god-file split relocates the
   * `setInterval` into a new service file; every other check stays green).
   *
   * Adopt it in batches, on loops whose anchors have been eyeballed — a
   * mechanism claim on an un-reviewed anchor is just a warning waiting to
   * happen, and a check that greets you with dozens of them gets muted.
   */
  mechanism: z.array(z.enum(["poller", "queue"])).optional(),
  /**
   * pg-boss queue names this loop CONSUMES (Proposal 006 C2 root-fix). A queue is
   * defined at its producer/enqueue site (e.g. a shared `services.ts` registry)
   * but its lifecycle belongs to the consuming loop, which may live in a
   * different file. Declaring the names here lets reconciliation register a queue
   * fact by NAME — so a producer-registry definition is not a false "unregistered"
   * just because its file carries no anchor. This is an explicit modeling
   * assertion ("this loop consumes order:process"), verified against the
   * consumer's queue handler; it is NOT a way to silence facts (that would be a
   * dormant loop) and NOT a synthetic node (a registry file is not a loop).
   */
  consumes_queues: z.array(z.string()).default([]),
  scenarios: z.array(ScenarioId).default([]),
  crux: z.array(Crux).optional(),
  notes: z.string().optional(),
});
export type Loop = z.infer<typeof Loop>;

/**
 * Flow = composite flow (C1..C9). `traverses` is the ordered loop sequence;
 * `guarded_by` holds watchdog loops (e.g. C1's L9) that don't sit in the
 * primary sequence but cover it; `references` holds sub-flow composition
 * (e.g. C1 references C2/C3 as expandable sub-chains).
 */
export const Flow = z.object({
  id: FlowId,
  kind: z.literal("flow"),
  title: z.string().min(1),
  traverses: z.array(LoopId).default([]),
  guarded_by: z.array(LoopId).default([]),
  crosses: z.array(JunctionId).default([]),
  references: z.array(FlowId).default([]),
  /**
   * Code symbols this flow's implementation is pinned to (`path#symbol`), same
   * shape as `Loop.anchors`. ORTHOGONAL to `traverses`/`references`: those
   * compose other MODEL nodes (which loops/sub-flows the journey runs through),
   * while `anchors` binds the flow to real CODE — the escape hatch for a
   * flow-shaped repo (a CLI, a one-shot pipeline) whose journeys are not made of
   * background loops and would otherwise carry no code binding at all. A flow
   * that composes loops needs no anchors (its parts are anchored); a flow that
   * composes nothing relies on these to be checkable. Conformance grades a flow
   * on these when present (Proposal — Flow first-class / F1).
   */
  anchors: z.array(z.string()).default([]),
  /**
   * GWT scenarios that guard this flow's journey, `verified_by` pointing at real
   * tests — same mechanism as `Loop.scenarios` (F2b). A code-anchored flow with
   * no verified scenario is `partial`, not `met`: anchored ≠ tested. Only meaningful
   * for a GRADED flow (one with own anchors); a composition-only flow is graded
   * through its constituent loops, which carry their own scenarios.
   */
  scenarios: z.array(ScenarioId).default([]),
  crux: z.array(Crux).optional(),
  /**
   * Which KIND of flow this is (Proposal 012 §2.2) — the field that stops the
   * engine from guessing:
   *
   * - `composed`: a derived view. Its journey is made of other model nodes and
   *   it holds no implementation of its own; those nodes carry the anchors and
   *   are graded individually.
   * - `anchored`: it holds implementation itself (`anchors`) — the escape hatch
   *   for a flow-shaped repo (a CLI, a one-shot pipeline) whose journeys are not
   *   made of background loops. MAY also compose: an anchored flow's own anchors
   *   are its own contribution, distinct from the parts it composes, so that is
   *   not double-counting.
   *
   * OPTIONAL for backward compatibility: when omitted, `flowShape()` derives it
   * from whether `anchors` is non-empty. That derivation lives in exactly ONE
   * place so consumers never re-derive it (the mistake this field exists to
   * end); declaring it explicitly is preferred, and lets `check` catch a
   * `composed` flow that carries anchors.
   */
  shape: z.enum(["composed", "anchored"]).optional(),
  risk_notes: z.string().optional(),
  /**
   * Optional plain-language, developer-facing one-liner: what this journey does,
   * in words a newcomer understands ("发一条消息 → 系统跑完 → 回复送达"). Distinct
   * from `title` (a label) and `risk_notes` (risk commentary). Authored in the
   * model — the source of truth — so the `overview` projection stays model-driven
   * rather than carrying hardcoded per-flow prose in the renderer.
   */
  summary: z.string().optional(),
  status: ConsistencyStatus.default("unverified"),
});
export type Flow = z.infer<typeof Flow>;

/**
 * Does this flow's journey COMPOSE other model nodes, rather than binding to
 * code itself? Exhaustive over every composition field on `Flow` — keep it in
 * sync when one is added, the same discipline `collectReferences` in
 * src/validate/checks.ts is held to.
 *
 * Defined here, beside the schema, because two layers must agree on it and a
 * second copy is how they drift: conformance uses it to decide whether a flow
 * is graded at all, and `checkFlowScenarioIgnored` uses it to warn about the
 * scenarios that decision silently drops. If those two ever disagree, the
 * warning fires on the wrong flows — or worse, stays silent on the right ones.
 */
export function flowComposes(flow: Flow): boolean {
  return (
    flow.traverses.length > 0 ||
    flow.guarded_by.length > 0 ||
    flow.crosses.length > 0 ||
    flow.references.length > 0
  );
}

/**
 * The flow's shape, declared or derived — **the only place the derivation is
 * allowed to happen** (Proposal 012 §2.2 / T1).
 *
 * Before this existed, every consumer re-derived "is this flow anchored?" from
 * `anchors.length` on its own, and the ones that forgot to (graph, overview,
 * evidence, inspect, reconcile, diff) each became a bug. A single predicate
 * means a consumer either asks the question correctly or does not ask it.
 *
 * Derivation for an undeclared flow is deliberately the weakest possible rule —
 * "has anchors ⇒ anchored" — so it can never disagree with what an author who
 * DID declare `shape` meant. `checkFlowShapeConsistency` catches the one
 * combination where a declaration and the anchors contradict each other.
 */
export function flowShape(flow: Flow): "composed" | "anchored" {
  return flow.shape ?? (flow.anchors.length > 0 ? "anchored" : "composed");
}

/**
 * Is this flow graded by conformance on its own merits?
 *
 * Three cases, and the excluded one is the point:
 *   1. `anchored` → graded on its own anchors, EVEN IF it also composes.
 *   2. `composed` but composes NOTHING → graded, and will be a `no-anchor` gap:
 *      a journey bound to neither code nor other nodes is an unbacked claim.
 *   3. `composed` AND composes something → NOT graded. Its implementation IS
 *      the nodes it composes, which are graded already; grading it too would
 *      double-count their green and move the headline. Counted in
 *      `flowsExcluded` so the exclusion is visible, never silent.
 */
export function isGradedFlow(flow: Flow): boolean {
  return flowShape(flow) === "anchored" || !flowComposes(flow);
}

export const Junction = z.object({
  id: JunctionId,
  kind: z.literal("junction"),
  title: z.string().optional(),
  risk_class: RiskClass,
  /**
   * The two (or more) sides this junction sits between. Loop↔Loop was the only
   * expressible shape until Flow became a first-class, code-anchored node
   * (Proposal 012): a handoff can just as easily sit between a flow and a loop,
   * or between two flows, and until Proposal 016 T4 the only way to write one
   * down was to demote the finding to a `debt` entry — losing the `risk_class`,
   * the `evidence` and the `scenarios` that are what make a junction actionable
   * (two findings lost that way in the 0.8.0 external evaluation, D3).
   *
   * `LoopId` and `FlowId` match disjoint id shapes, so which kind an endpoint
   * names is always recoverable from the string alone — see
   * `junctionEndpointKind`, the one place that derivation is allowed to happen.
   */
  between: z.array(z.union([LoopId, FlowId])).min(1),
  scenarios: z.array(ScenarioId).default([]),
  evidence: z.array(Evidence).default([]),
  status: ConsistencyStatus.default("unverified"),
});
export type Junction = z.infer<typeof Junction>;

/**
 * Which kind a `Junction.between` endpoint names — the **only place that
 * derivation is allowed to happen**, the same discipline `flowShape` is held to
 * and for the same reason: every consumer that re-derives it on its own is a
 * bug waiting to be written.
 *
 * Total by construction. The schema accepts an endpoint only if it matched
 * `LoopId` (`L1` / `L1a` / `N32`) or `FlowId` (`C42`), and those two regexes are
 * disjoint, so "not flow-shaped" means "loop-shaped".
 *
 * A consumer holding a loaded graph should still prefer looking the id up
 * (`getNode`) — that is the ground truth. This answers the question for a
 * DANGLING endpoint too, which is what lets `check` report a missing `C99` as
 * "not a defined flow" instead of "not a defined loop".
 */
export function junctionEndpointKind(id: string): "loop" | "flow" {
  return FlowId.safeParse(id).success ? "flow" : "loop";
}

/**
 * Selector for effective-constraints propagation (Decision record 004,
 * 技术点 2): decides which nodes an Invariant-flavored Scenario applies
 * to automatically, without hand-listing the scenario id in every
 * relevant node's `scenarios` array. Resolved at query time by
 * src/query/effective-constraints.ts, never materialized — see that
 * module for match semantics (owner_match is substring containment with
 * optional `*` wildcard, NOT prefix-anchored or POSIX glob).
 */
export const AppliesTo = z.object({
  nodes: z.array(z.string()).default([]),
  owner_match: z.string().min(1).optional(), // empty string would match every non-dormant Loop — reject rather than allow the footgun
});
export type AppliesTo = z.infer<typeof AppliesTo>;

/**
 * A test anchor written as TEXT instead of `path#symbol`.
 *
 * WHY THIS EXISTS. A JS/TS test's identity is usually a STRING, not a symbol:
 * `it('claimAsRunning transitions QUEUED -> RUNNING and returns the job')`.
 * The `path#symbol` form's symbol segment is `[\w.]+`, so an author with a
 * real test title has exactly two options, and both are bad: skip
 * `verified_by` (the behaviour reads as unguarded), or underscore the title
 * into `#claimAsRunning_transitions_QUEUED_to_RUNNING…` — a symbol that
 * appears nowhere in the file, so the anchor is stale the day it is written.
 * Measured on a real target: 5 of 5 test anchors on the model's only `met`
 * node were underscored titles, every one of them a phantom.
 *
 * The mechanism is NOT new — it is `crux`'s (Proposal 013 B2): two-tier
 * matching (exact substring, then whitespace-normalized) against the file's
 * text, always a warning, never promoted by `--strict-anchors`. See crux.ts.
 */
export const TestTextAnchor = z.object({
  file: z.string().min(1),
  text: z.string().min(1),
});
export type TestTextAnchor = z.infer<typeof TestTextAnchor>;

export const Scenario = z.object({
  id: ScenarioId,
  kind: z.literal("scenario"),
  given: z.string().min(1),
  when: z.string().min(1),
  // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the GWT domain vocabulary, not a thenable
  then: z.string().min(1),
  level: z.enum(["unit", "focused-integration", "contract", "integration", "e2e", "operational"]),
  /** `path#symbol` test anchors. Text-form entries are moved out — see below. */
  verified_by: z.array(z.string()).default([]),
  /**
   * NORMALIZED LANDING FIELD, not a second thing for authors to remember.
   * Authors write both anchor forms inline in ONE `verified_by` list:
   *
   *     verified_by:
   *       - test/unit/job.spec.ts#JobRepository        # symbol form
   *       - {file: test/e2e/chain.spec.ts, text: "resumes a stranded chain"}
   *
   * and `loadModel` moves the object entries here before validation (see
   * `splitVerifiedBy` in loader/load-model.ts). Kept as a separate field
   * rather than widening `verified_by`'s element type because the two forms
   * are checked by different mechanisms and because a union element type
   * would force every display/query consumer of `verified_by` to branch —
   * `crux` sits beside `anchors` for the same reason. Read both together via
   * `scenarioTestAnchorLabels` / `scenarioHasTestEvidence`; a bare
   * `verified_by.length` under-reports a text-anchored scenario.
   */
  verified_by_text: z.array(TestTextAnchor).default([]),
  applies_to: AppliesTo.optional(),
});
export type Scenario = z.infer<typeof Scenario>;

/** Human-readable form of a text anchor, for reports and diff identity. */
export function testTextAnchorLabel(a: TestTextAnchor): string {
  return `${a.file} :: "${a.text}"`;
}

/**
 * Every test anchor a scenario carries, in display form — the honest answer to
 * "what does this scenario point at?" across BOTH anchor forms. Use this
 * anywhere `verified_by` was previously read directly for display or counting.
 */
export function scenarioTestAnchorLabels(s: Scenario): string[] {
  return [...s.verified_by, ...s.verified_by_text.map(testTextAnchorLabel)];
}

/** Does this scenario point at any test at all (either anchor form)? */
export function scenarioHasTestEvidence(s: Scenario): boolean {
  return s.verified_by.length > 0 || s.verified_by_text.length > 0;
}

export const Feature = z.object({
  id: FeatureId,
  kind: z.literal("feature"),
  title: z.string().min(1),
  contains: z.array(FlowId).default([]),
  status: ConsistencyStatus.default("unverified"),
});
export type Feature = z.infer<typeof Feature>;

/**
 * DebtEntry is deliberately a different shape from Loop: the 6
 * dead-state-machine tables and 2 deferred loops from the seed baseline describe
 * something that LOOKS like a loop (has a status column / was scoped as
 * a loop) but fails the "independent advance mechanism" test — they are
 * baseline debt, not behavior to model as Loop nodes.
 */
export const DebtId = z.string().regex(/^DEBT-[A-Za-z0-9-]+$/, "debt id must look like DEBT-xxx");
export type DebtId = z.infer<typeof DebtId>;

export const DebtEntry = z.object({
  id: DebtId,
  kind: z.literal("debt"),
  category: DebtCategory,
  subject: z.string().min(1),
  claim: z.string().optional(),
  reality: z.string().min(1),
  owner: z.string().optional(),
  removal_condition: z.string().optional(),
});
export type DebtEntry = z.infer<typeof DebtEntry>;

export const ModelNode = z.discriminatedUnion("kind", [
  Feature,
  Flow,
  Loop,
  Junction,
  Scenario,
  DebtEntry,
]);
export type ModelNode = z.infer<typeof ModelNode>;
