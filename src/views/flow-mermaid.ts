import type { ModelGraph } from "../loader/model-graph.js";
import type { Junction } from "../schema/index.js";

/**
 * Escapes a title for use inside a mermaid `["..."]` quoted node label.
 * `title` is unconstrained free text (schema: `z.string().min(1)`, no
 * charset restriction), so two things need handling: a literal `"`
 * would close the quoted label early, and a literal newline would
 * split this function's one-line-per-node output across lines,
 * corrupting the line-based structure `renderFlowMermaid` generates —
 * collapsed to a space rather than stripped, so the text stays
 * readable. Ordinary punctuation (`]`, `#`, etc.) needs no escaping:
 * verified against a real mmdc render — mermaid's quoted-bracket label
 * syntax tolerates it as literal text.
 */
function quoteLabel(text: string): string {
  return text.replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

function nodeDecl(id: string, title: string): string {
  return `  ${id}["${id}: ${quoteLabel(title)}"]`;
}

/**
 * Renders a Flow (e.g. C1) as a mermaid `flowchart`, per Decision record
 * 004 技术点 5 (Phase 1, C1 only — proposal 001 §12 success-criteria
 * scope, not all 9 Flows). Structure:
 *
 * - Nodes: the Flow itself, every Loop in `traverses`/`guarded_by`, and
 *   every node referenced by a crossing Junction's `between` (covers
 *   Loops that aren't in `traverses`/`guarded_by` at all, e.g. a
 *   junction linking two loops outside this flow's primary chain).
 *   `between` accepts a FlowId as well as a LoopId (Proposal 016 T4 — a
 *   Loop↔Flow or Flow↔Flow handoff is expressible), so an endpoint's
 *   title is resolved against BOTH tables; a loop-only lookup left every
 *   flow endpoint rendered as a bare, untitled `C10["C10: C10"]` box.
 * - Edges: `traverses` rendered as the plain forward sequence; each
 *   `guarded_by` Loop as a dashed "guards" edge into the Flow node
 *   (flow-level watchdog coverage, not tied to one step); each crossing
 *   Junction as its OWN dashed edge, drawn literally from
 *   `junction.between[0]` to `junction.between[1]` and labeled with the
 *   junction id + risk_class.
 *
 * The junction edges are deliberately NOT inferred by walking
 * `traverses` as a forward chain and matching adjacent pairs — real flow
 * data has junctions that aren't forward-adjacent traversal steps at all
 * (a projection junction can be a backward edge from the last traverses
 * step to an earlier one; a watchdog junction can link a `guarded_by`
 * loop to a traverses step, not two traverses steps). Inferring from
 * adjacency would silently drop both — 2 of the 5 risk classes
 * (projection, watchdog). Drawing every
 * junction from its own literal `between` pair, unconditionally, can't
 * drop any of them.
 */
export function renderFlowMermaid(graph: ModelGraph, flowId: string): string {
  const flow = graph.byKind.flow.get(flowId);
  if (!flow) throw new Error(`renderFlowMermaid: no such flow "${flowId}"`);

  const crossingJunctions = flow.crosses
    .map((id) => graph.byKind.junction.get(id))
    .filter((j): j is Junction => j !== undefined);

  const nodeIds = new Set<string>([
    ...flow.traverses,
    ...flow.guarded_by,
    ...crossingJunctions.flatMap((j) => j.between),
  ]);

  const lines: string[] = ["flowchart TB", nodeDecl(flow.id, flow.title)];
  for (const nodeId of nodeIds) {
    // This flow is already declared above. A junction whose `between` names it
    // (the Loop↔Flow handoff T4 made expressible) would otherwise emit a SECOND
    // declaration of the same id carrying `C1: C1` as its label — mermaid keeps
    // the last one, so the flow's real title silently disappeared from the box.
    if (nodeId === flow.id) continue;
    const title = graph.byKind.flow.get(nodeId)?.title ?? graph.byKind.loop.get(nodeId)?.title;
    lines.push(nodeDecl(nodeId, title ?? nodeId));
  }

  lines.push("");
  if (flow.traverses.length > 0) {
    const [first, ...rest] = flow.traverses;
    lines.push(`  ${flow.id} --> ${first}`);
    let prev = first;
    for (const next of rest) {
      lines.push(`  ${prev} --> ${next}`);
      prev = next;
    }
  }
  for (const guardId of flow.guarded_by) {
    lines.push(`  ${guardId} -.->|guards| ${flow.id}`);
  }

  lines.push("");
  for (const junction of crossingJunctions) {
    const [from, to] = junction.between;
    if (from === undefined || to === undefined) continue; // schema allows a 1-element `between`; no edge to draw
    // The label carries the endpoints explicitly (`from→to`) so a reader never
    // has to infer direction from the auto-layout (Report 005 §5 建议 1): mermaid
    // routes non-adjacent/reverse dashed edges close together — and readers
    // misread which end is which. Stating it in the label removes the ambiguity.
    lines.push(`  ${from} -.->|"${junction.id}: ${junction.risk_class} (${from}→${to})"| ${to}`);
  }

  return lines.join("\n");
}
