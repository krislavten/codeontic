import type { ModelGraph } from "../loader/model-graph.js";
import { getNode } from "../loader/model-graph.js";
import type { ModelNode } from "../schema/index.js";
import { scenarioTestAnchorLabels } from "../schema/model.js";
import { resolveApplicableScenarios, scenarioApplies } from "./effective-constraints.js";

/**
 * The Phase-2 query command family (Proposal 006 B4 / 001 §4.2 §8):
 * `impact` / `plan` / `scenario` / `evidence` — focused views over the model,
 * distinct from A5's general-purpose `inspect` slice. All are PURE functions of
 * the loaded graph; the CLI and MCP layers add I/O (side-channel file) around
 * them. Each returns `undefined` when the id isn't found (callers turn that
 * into an "unknown id" error), and a small structured result the renderers in
 * this file turn into a stdout summary + a full side-channel body.
 */

// ---------- impact: reverse-dependency blast radius ----------

export interface Dependent {
  id: string;
  kind: ModelNode["kind"];
  /** How it depends on the queried node (which reference field links them). */
  relation: string;
}

export interface ImpactResult {
  nodeId: string;
  kind: ModelNode["kind"];
  dependents: Dependent[];
}

/**
 * Everything that references `nodeId` — the set a change to it may force you to
 * re-check. Reverse edges only (who points AT this node), deliberately NOT the
 * general bidirectional slice `inspect` gives: this answers "if I change X,
 * what's the blast radius", not "what's near X".
 */
export function impactOf(graph: ModelGraph, nodeId: string): ImpactResult | undefined {
  const node = getNode(graph, nodeId);
  if (!node) return undefined;

  const dependents: Dependent[] = [];
  const seen = new Set<string>(); // dedup by id: a node is one dependent even if linked two ways
  const add = (id: string, kind: ModelNode["kind"], relation: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    dependents.push({ id, kind, relation });
  };

  for (const flow of graph.byKind.flow.values()) {
    if (flow.traverses.includes(nodeId)) add(flow.id, "flow", "traverses");
    if (flow.guarded_by.includes(nodeId)) add(flow.id, "flow", "guarded_by");
    if (flow.crosses.includes(nodeId)) add(flow.id, "flow", "crosses");
    if (flow.references.includes(nodeId)) add(flow.id, "flow", "references");
  }
  for (const feature of graph.byKind.feature.values()) {
    if (feature.contains.includes(nodeId)) add(feature.id, "feature", "contains");
  }
  for (const loop of graph.byKind.loop.values()) {
    if (loop.parent === nodeId) add(loop.id, "loop", "parent");
    if (loop.scenarios.includes(nodeId)) add(loop.id, "loop", "scenarios");
  }
  for (const junction of graph.byKind.junction.values()) {
    if (junction.between.includes(nodeId)) add(junction.id, "junction", "between");
    if (junction.scenarios.includes(nodeId)) add(junction.id, "junction", "scenarios");
  }
  // A loop is also "impacted" by any invariant scenario that applies to it via
  // applies_to — and a scenario's impact includes the loops it constrains.
  if (node.kind === "scenario") {
    for (const loop of graph.byKind.loop.values()) {
      if (scenarioApplies(node, loop.id, graph)) add(loop.id, "loop", "applies_to");
    }
  } else if (node.kind === "loop") {
    for (const s of resolveApplicableScenarios(graph, nodeId)) add(s.id, "scenario", "applies_to→");
  }

  // stable order: kind then id
  dependents.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { nodeId, kind: node.kind, dependents };
}

// ---------- plan: a flow's ordered execution path ----------

export interface PlanStep {
  loopId: string;
  title: string;
  status: string;
  /** effective-constraint scenario ids that apply to this loop (invariants). */
  effectiveConstraints: string[];
}

export interface PlanResult {
  flowId: string;
  title: string;
  steps: PlanStep[];
  guards: { loopId: string; title: string }[];
  junctions: { id: string; risk_class: string; between: string[]; title: string }[];
  subFlows: string[];
}

/** The ordered "how this flow runs" plan: traverses sequence, guards, crossing junctions. */
export function planOf(graph: ModelGraph, flowId: string): PlanResult | undefined {
  const flow = graph.byKind.flow.get(flowId);
  if (!flow) return undefined;

  const steps: PlanStep[] = flow.traverses.map((loopId) => {
    const loop = graph.byKind.loop.get(loopId);
    return {
      loopId,
      title: loop?.title ?? loopId,
      status: loop?.status ?? "unknown",
      effectiveConstraints: resolveApplicableScenarios(graph, loopId).map((s) => s.id),
    };
  });
  const guards = flow.guarded_by.map((loopId) => ({
    loopId,
    title: graph.byKind.loop.get(loopId)?.title ?? loopId,
  }));
  const junctions = flow.crosses
    .map((id) => graph.byKind.junction.get(id))
    .filter((j): j is NonNullable<typeof j> => j !== undefined)
    .map((j) => ({
      id: j.id,
      risk_class: j.risk_class,
      between: j.between,
      title: j.title ?? "",
    }));
  return { flowId, title: flow.title, steps, guards, junctions, subFlows: flow.references };
}

// ---------- scenario: a GWT's full detail + who uses it ----------

export interface ScenarioResult {
  scenario: import("../schema/index.js").Scenario;
  /** loops/junctions that list this scenario in their `scenarios` array. */
  referencedBy: { id: string; kind: "loop" | "junction" }[];
  /** loops this scenario applies to via applies_to (resolved at query time). */
  appliesToLoops: string[];
}

export function scenarioDetail(graph: ModelGraph, scenarioId: string): ScenarioResult | undefined {
  const scenario = graph.byKind.scenario.get(scenarioId);
  if (!scenario) return undefined;

  const referencedBy: { id: string; kind: "loop" | "junction" }[] = [];
  for (const loop of graph.byKind.loop.values())
    if (loop.scenarios.includes(scenarioId)) referencedBy.push({ id: loop.id, kind: "loop" });
  for (const junction of graph.byKind.junction.values())
    if (junction.scenarios.includes(scenarioId))
      referencedBy.push({ id: junction.id, kind: "junction" });

  const appliesToLoops = [...graph.byKind.loop.values()]
    .filter((l) => scenarioApplies(scenario, l.id, graph))
    .map((l) => l.id);

  return { scenario, referencedBy, appliesToLoops };
}

// ---------- evidence: a node's grounding ----------

export interface EvidenceResult {
  nodeId: string;
  kind: ModelNode["kind"];
  /** Junction evidence entries (kind/anchor/note), if the node is a junction. */
  evidence: import("../schema/index.js").Evidence[];
  /** Anchor strings, if the node carries its own (loop or flow). */
  anchors: string[];
  /** scenarios bound to this node (its own `scenarios` + effective constraints for loops). */
  scenarios: string[];
}

export function evidenceOf(graph: ModelGraph, nodeId: string): EvidenceResult | undefined {
  const node = getNode(graph, nodeId);
  if (!node) return undefined;
  const evidence = node.kind === "junction" ? node.evidence : [];
  // Flows carry anchors/scenarios of their own since F1/F2b — reporting a
  // flow's grounding as empty makes the new binding channel invisible on the
  // one surface (`codeontic evidence`, MCP `model_evidence`) whose whole job is
  // answering "what is this node grounded in?".
  const anchors = node.kind === "loop" || node.kind === "flow" ? node.anchors : [];
  const own =
    node.kind === "loop" || node.kind === "junction" || node.kind === "flow" ? node.scenarios : [];
  const eff =
    node.kind === "loop" ? resolveApplicableScenarios(graph, nodeId).map((s) => s.id) : [];
  const scenarios = [...new Set([...own, ...eff])];
  return { nodeId, kind: node.kind, evidence, anchors, scenarios };
}

// ---------- matrix: a flow's GWT ↔ test coverage matrix (B5) ----------

export interface MatrixRow {
  scenarioId: string;
  level: string;
  /** Test anchors this GWT is bound to (Scenario.verified_by). Empty = unverified. */
  verifiedBy: string[];
  /** in-flow nodes (junction/loop) that reference this scenario, or "applies_to" for an invariant. */
  referencedBy: string[];
  verified: boolean;
}

export interface TestMatrixResult {
  flowId: string;
  title: string;
  rows: MatrixRow[];
  /**
   * `unknownScenario` counts rows whose scenario id resolved to no Scenario
   * node — always 0 on a T0-passing model (referential integrity catches
   * dangling scenario refs), surfaced anyway so a broken model isn't silent.
   */
  summary: { total: number; verified: number; unverified: number; unknownScenario: number };
}

/**
 * The GWT↔test binding matrix for a flow (Proposal 006 B5 / 001 §12 "GWT 独立于
 * 测试代码长期存在"): every scenario reachable from the flow — via its crossing
 * junctions, its traversed/guarding loops, and each loop's effective
 * constraints — with the tests it's bound to and whether it's verified. Makes
 * the flow's test-coverage surface legible at a glance (which GWT are grounded
 * in a real test, which are deliberately unverified).
 */
export function testMatrix(graph: ModelGraph, flowId: string): TestMatrixResult | undefined {
  const flow = graph.byKind.flow.get(flowId);
  if (!flow) return undefined;

  // scenarioId → the in-flow nodes that pull it in (deduped, ordered).
  const refs = new Map<string, Set<string>>();
  const addRef = (scenarioId: string, from: string) => {
    const set = refs.get(scenarioId) ?? new Set<string>();
    set.add(from);
    refs.set(scenarioId, set);
  };

  for (const jid of flow.crosses) {
    const junction = graph.byKind.junction.get(jid);
    for (const s of junction?.scenarios ?? []) addRef(s, jid);
  }
  for (const lid of [...flow.traverses, ...flow.guarded_by]) {
    const loop = graph.byKind.loop.get(lid);
    for (const s of loop?.scenarios ?? []) addRef(s, lid);
    for (const s of resolveApplicableScenarios(graph, lid)) addRef(s.id, `${lid}:applies_to`);
  }

  const rows: MatrixRow[] = [...refs.keys()]
    .map((scenarioId) => {
      const scenario = graph.byKind.scenario.get(scenarioId);
      // Both anchor forms, in display form — a text-anchored scenario is
      // verified, and a matrix that read `verified_by` alone would call it a
      // hole (schema `TestTextAnchor`).
      const verifiedBy = scenario ? scenarioTestAnchorLabels(scenario) : [];
      return {
        scenarioId,
        level: scenario?.level ?? "unknown",
        verifiedBy,
        referencedBy: [...(refs.get(scenarioId) ?? [])].sort(),
        verified: verifiedBy.length > 0,
      };
    })
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));

  const verified = rows.filter((r) => r.verified).length;
  const unknownScenario = rows.filter((r) => r.level === "unknown").length;
  return {
    flowId,
    title: flow.title,
    rows,
    summary: { total: rows.length, verified, unverified: rows.length - verified, unknownScenario },
  };
}
