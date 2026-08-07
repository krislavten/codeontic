import type { ModelGraph } from "../loader/model-graph.js";
import { getNode } from "../loader/model-graph.js";
import type { ModelNode } from "../schema/index.js";
import { junctionEndpointKind } from "../schema/model.js";
import { resolveApplicableScenarios, scenarioApplies } from "./effective-constraints.js";

/**
 * Reusable model-slice join (Proposal 006 A5). Given a start node id and a
 * traversal depth, produce the connected task-relevant sub-graph:
 * flow→loops/junctions/sub-flows, loop→junctions/scenarios/parent/effective
 * constraints, junction→loops/scenarios, scenario→referrers/applies_to.
 *
 * This is deliberately factored out of the `inspect` CLI command so the
 * Phase 2 query family (`model impact`/`plan`/`scenario`/`evidence`) reuses
 * one traversal + one summary/truncation module (proposal 001 §4.2), rather
 * than each command re-deriving "what's related to X".
 */

export interface SliceNode {
  id: string;
  kind: ModelNode["kind"];
  /** Shortest hop distance from the root (root = 0). */
  depth: number;
  node: ModelNode;
  /**
   * For loops only: scenario ids that apply via `applies_to` (effective
   * constraints, Decision 004 技术点 2) — computed at query time, not
   * hand-listed on the node. Undefined for non-loop kinds.
   */
  effectiveConstraints?: string[];
}

/** A neighbor one hop past the traversal frontier, surfaced as a pointer (not expanded). */
export interface FrontierPointer {
  id: string;
  kind: ModelNode["kind"];
  /** An in-slice node that references this pointer (so the user knows where it hangs off). */
  fromId: string;
}

export interface ModelSlice {
  rootId: string;
  rootKind: ModelNode["kind"];
  maxDepth: number;
  /** Reached nodes, ordered by (depth, id). Includes the root at depth 0. */
  nodes: SliceNode[];
  /** Neighbors beyond `maxDepth` that were not expanded — expand with `--depth`. */
  frontierPointers: FrontierPointer[];
}

/** Every related node id (forward + relevant reverse edges), deduped, kind-tagged. */
function neighbors(graph: ModelGraph, node: ModelNode): { id: string; kind: ModelNode["kind"] }[] {
  const out: { id: string; kind: ModelNode["kind"] }[] = [];
  const add = (id: string, kind: ModelNode["kind"]) => out.push({ id, kind });

  switch (node.kind) {
    case "feature":
      for (const f of node.contains) add(f, "flow");
      break;
    case "flow":
      for (const l of node.traverses) add(l, "loop");
      for (const l of node.guarded_by) add(l, "loop");
      for (const j of node.crosses) add(j, "junction");
      for (const f of node.references) add(f, "flow");
      // F2b: a flow carries its own scenarios. Without this edge, `inspect`/
      // `impact` on a flow can never reach the GWTs guarding it.
      for (const s of node.scenarios) add(s, "scenario");
      // reverse: junctions naming this flow as an endpoint (Proposal 016 T4 —
      // `between` accepts flow ids). Mirrors the loop branch below. No model
      // written before T4 can reach this edge: a flow id in `between` was a
      // schema error until now.
      for (const j of graph.byKind.junction.values())
        if (j.between.includes(node.id)) add(j.id, "junction");
      break;
    case "loop": {
      if (node.parent) add(node.parent, "loop");
      for (const s of node.scenarios) add(s, "scenario");
      // reverse: junctions this loop sits between, flows that traverse/guard it
      for (const j of graph.byKind.junction.values())
        if (j.between.includes(node.id)) add(j.id, "junction");
      for (const f of graph.byKind.flow.values())
        if (f.traverses.includes(node.id) || f.guarded_by.includes(node.id)) add(f.id, "flow");
      // effective constraints: invariant scenarios that apply via applies_to
      for (const s of resolveApplicableScenarios(graph, node.id)) add(s.id, "scenario");
      break;
    }
    case "junction":
      // Endpoints are loops OR flows since Proposal 016 T4. The loaded node's
      // real kind is the ground truth; the id-shape derivation is the fallback
      // for a DANGLING endpoint, so the frontier pointer still gets a kind
      // label (referential-integrity owns reporting that it dangles).
      for (const id of node.between) add(id, getNode(graph, id)?.kind ?? junctionEndpointKind(id));
      for (const s of node.scenarios) add(s, "scenario");
      break;
    case "scenario": {
      for (const targetId of node.applies_to?.nodes ?? []) {
        const target = getNode(graph, targetId);
        if (target) add(targetId, target.kind);
      }
      // reverse: nodes that list this scenario, plus loops it applies to via owner_match
      for (const l of graph.byKind.loop.values()) {
        if (l.scenarios.includes(node.id)) add(l.id, "loop");
        else if (scenarioApplies(node, l.id, graph)) add(l.id, "loop");
      }
      for (const j of graph.byKind.junction.values())
        if (j.scenarios.includes(node.id)) add(j.id, "junction");
      // Same linear reverse scan the loop/junction branches above already do —
      // no scenario→node reverse index exists on ModelGraph. Fine at model
      // scale (nodes are hand-authored, hundreds not millions); if one is ever
      // added, all three of these scans should move onto it together.
      for (const f of graph.byKind.flow.values())
        if (f.scenarios.includes(node.id)) add(f.id, "flow");
      break;
    }
    case "debt":
      break;
  }

  const seen = new Set<string>();
  return out.filter((n) => (seen.has(n.id) ? false : seen.add(n.id)));
}

/**
 * Depth-limited breadth-first slice from `rootId`. Returns undefined if the
 * root id isn't a node in the graph (the CLI turns that into an "unknown id"
 * error).
 *
 * Standard mark-at-enqueue BFS: a node is added to `enqueued` the moment it's
 * first discovered, so (a) each node is enqueued exactly once and recorded at
 * its shortest distance from the root, and (b) any node reachable within
 * `maxDepth` is marked (via its shallower parent, which the depth-ordered FIFO
 * dequeues first) before a depth==maxDepth sibling could add it to the
 * frontier — so `frontierPointers` and the in-slice node set never overlap by
 * construction, no post-hoc reconciliation needed.
 */
export function sliceModel(
  graph: ModelGraph,
  rootId: string,
  maxDepth: number,
): ModelSlice | undefined {
  const root = getNode(graph, rootId);
  if (!root) return undefined;

  const enqueued = new Set<string>([rootId]);
  const nodesById = new Map<string, SliceNode>();
  const frontier = new Map<string, FrontierPointer>();
  const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break; // queue.length>0 guarantees this; guard, not assertion
    const { id, depth } = item;
    const node = getNode(graph, id);
    if (!node) continue; // dangling reference — T0's referential-integrity check owns reporting it

    const sliceNode: SliceNode = { id, kind: node.kind, depth, node };
    if (node.kind === "loop") {
      sliceNode.effectiveConstraints = resolveApplicableScenarios(graph, id).map((s) => s.id);
    }
    nodesById.set(id, sliceNode);

    for (const nb of neighbors(graph, node)) {
      if (enqueued.has(nb.id)) continue; // already in-slice (or queued to be) — never a frontier pointer
      if (depth < maxDepth) {
        enqueued.add(nb.id);
        queue.push({ id: nb.id, depth: depth + 1 });
      } else if (!frontier.has(nb.id)) {
        frontier.set(nb.id, { id: nb.id, kind: nb.kind, fromId: id });
      }
    }
  }

  const nodes = [...nodesById.values()].sort(
    (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
  );
  return {
    rootId,
    rootKind: root.kind,
    maxDepth,
    nodes,
    frontierPointers: [...frontier.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
