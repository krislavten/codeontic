import type { ModelGraph } from "../loader/model-graph.js";
import { allNodes } from "../loader/model-graph.js";
import type { Scenario } from "../schema/index.js";

/**
 * `owner_match` matching semantics (Decision record 004, 技术点 2):
 * `Loop.owner` is free text, not a clean path (e.g. an owner might read
 * `"canonical writer = packages/core service; ui layer read-only"` — the
 * package path is not a prefix). A pattern with no `*` is a
 * substring-containment check anywhere in `owner`. A pattern with `*`
 * treats it as "any-length any-characters" (like a simplified `.*`),
 * useful for asserting two fragments appear in a given order — e.g.
 * `"packages/core*apps/worker"`. This is deliberately NOT full POSIX glob
 * (no `**`, no character classes) — `owner` is a short free-text field,
 * not a file path, and doesn't need that vocabulary. Case-sensitive,
 * matching `owner`'s own casing.
 *
 * The `*`-pattern match is deliberately UNANCHORED (no `^`/`$`), for the
 * same reason the no-`*` case is substring-anywhere and not a full-string
 * equality check: real `owner` values carry surrounding decoration, so
 * "these two fragments appear in this order" needs to tolerate a
 * prefix/suffix around the whole match, not just between the two
 * fragments. Anchoring would make `*`-patterns behave inconsistently
 * stricter than plain-substring patterns for no benefit — `owner` isn't
 * adversarial input, it's short static text authored by whoever wrote
 * the model.
 */
export function ownerMatches(owner: string, pattern: string): boolean {
  if (!pattern.includes("*")) return owner.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped).test(owner);
}

/**
 * Whether `scenario` applies to `nodeId`, per its `applies_to` selector.
 * Predicates combine with OR (matching either is sufficient). `nodes`
 * works against any of the 6 node kinds by exact id; `owner_match` only
 * ever matches Loop nodes (other kinds have no `owner` field) and never
 * matches a dormant loop (`owner: null`).
 */
export function scenarioApplies(scenario: Scenario, nodeId: string, graph: ModelGraph): boolean {
  const appliesTo = scenario.applies_to;
  if (!appliesTo) return false;

  if (appliesTo.nodes.includes(nodeId)) return true;

  if (appliesTo.owner_match !== undefined) {
    const loop = graph.byKind.loop.get(nodeId);
    if (loop && loop.owner !== null && ownerMatches(loop.owner, appliesTo.owner_match)) {
      return true;
    }
  }

  return false;
}

/**
 * Every Scenario that applies to `nodeId`, resolved at query time —
 * never materialized back onto the node (Decision record 004: writing
 * this back to every matching node's `scenarios` array on every new
 * Invariant would create merge conflicts across the user's many git
 * worktrees, for no correctness benefit at this model's node count).
 */
export function resolveApplicableScenarios(graph: ModelGraph, nodeId: string): Scenario[] {
  return [...graph.byKind.scenario.values()].filter((scenario) =>
    scenarioApplies(scenario, nodeId, graph),
  );
}

/** Every (scenario, nodeId) pair where a Scenario's `applies_to` names a node that doesn't exist in the graph. */
export function collectDanglingAppliesTo(
  graph: ModelGraph,
): { scenarioId: string; targetId: string }[] {
  const out: { scenarioId: string; targetId: string }[] = [];
  for (const node of allNodes(graph)) {
    if (node.kind !== "scenario" || !node.applies_to) continue;
    for (const targetId of node.applies_to.nodes) {
      const exists =
        graph.byKind.feature.has(targetId) ||
        graph.byKind.flow.has(targetId) ||
        graph.byKind.loop.has(targetId) ||
        graph.byKind.junction.has(targetId) ||
        graph.byKind.scenario.has(targetId) ||
        graph.byKind.debt.has(targetId);
      if (!exists) out.push({ scenarioId: node.id, targetId });
    }
  }
  return out;
}
