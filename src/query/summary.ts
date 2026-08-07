import type { ModelNode } from "../schema/index.js";
import { scenarioTestAnchorLabels } from "../schema/model.js";
import type { ModelSlice, SliceNode } from "./slice.js";

/**
 * Summary + full-render for a ModelSlice (Proposal 006 A5), factored out
 * alongside sliceModel so the Phase 2 query family shares one truncation
 * policy. Two outputs:
 *  - `summarizeSlice`: compact stdout digest. Keeps EVERY node's skeleton
 *    (id/title/risk_class/status + child counts); truncates only the
 *    evidence/scenario prose, with an explicit "full detail in <file>" hint.
 *  - `renderSliceMarkdown`: the full side-channel body (nothing truncated).
 */

const KIND_ORDER: ModelNode["kind"][] = ["feature", "flow", "loop", "junction", "scenario", "debt"];

/** A short, single-line human label for a node — its "skeleton" identity. */
function label(node: ModelNode): string {
  switch (node.kind) {
    case "feature":
    case "flow":
    case "loop":
      return node.title;
    case "junction":
      return node.title ?? "(untitled junction)";
    case "scenario":
      return truncate(node.given, 60);
    case "debt":
      return node.subject;
  }
}

/** Bracketed status/classification tag for the skeleton line. */
function tag(node: ModelNode): string {
  switch (node.kind) {
    case "feature":
    case "flow":
    case "loop":
      return node.status;
    case "junction":
      return `${node.risk_class}/${node.status}`;
    case "scenario":
      return node.level;
    case "debt":
      return node.category;
  }
}

/** Child-count suffix shown on the skeleton line (the counts, never the prose). */
function counts(sn: SliceNode): string {
  const n = sn.node;
  switch (n.kind) {
    case "flow":
      return `loops:${n.traverses.length + n.guarded_by.length} junctions:${n.crosses.length}`;
    case "loop":
      return `scenarios:${n.scenarios.length} eff:${sn.effectiveConstraints?.length ?? 0}`;
    case "junction":
      return `evidence:${n.evidence.length} scenarios:${n.scenarios.length}`;
    case "scenario":
      return `verified:${scenarioTestAnchorLabels(n).length}`;
    default:
      return "";
  }
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function groupByKind(nodes: SliceNode[]): Map<ModelNode["kind"], SliceNode[]> {
  const groups = new Map<ModelNode["kind"], SliceNode[]>();
  for (const sn of nodes) {
    const list = groups.get(sn.kind) ?? [];
    list.push(sn);
    groups.set(sn.kind, list);
  }
  return groups;
}

/**
 * Compact stdout summary. `outputPath` is named so the truncation hint can
 * point the reader at the full side-channel file.
 */
export function summarizeSlice(slice: ModelSlice, outputPath: string): string {
  const groups = groupByKind(slice.nodes);
  const lines: string[] = [
    `inspect ${slice.rootId} (${slice.rootKind}) — depth ${slice.maxDepth}, ${slice.nodes.length} node(s)`,
  ];

  for (const kind of KIND_ORDER) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    lines.push(`  ${kind} (${list.length}):`);
    for (const sn of list) {
      const c = counts(sn);
      lines.push(`    ${sn.id}  ${label(sn.node)}  [${tag(sn.node)}]${c ? `  ${c}` : ""}`);
    }
  }

  if (slice.frontierPointers.length > 0) {
    lines.push(
      `  → ${slice.frontierPointers.length} node(s) beyond depth ${slice.maxDepth} not expanded (use --depth to go deeper):`,
    );
    lines.push(`    ${slice.frontierPointers.map((p) => `${p.id}(${p.kind})`).join(", ")}`);
  }

  // The one place details are truncated: evidence notes and scenario
  // given/when/then never appear above — they live in the side-channel file.
  lines.push(`  (evidence/scenario detail truncated — full slice written to ${outputPath})`);
  return lines.join("\n");
}

function renderNodeDetail(sn: SliceNode): string[] {
  const n = sn.node;
  const out: string[] = [`### ${n.id} — ${label(n)}  [${tag(n)}]  (depth ${sn.depth})`];
  switch (n.kind) {
    case "flow":
      if (n.traverses.length) out.push(`- traverses: ${n.traverses.join(", ")}`);
      if (n.guarded_by.length) out.push(`- guarded_by: ${n.guarded_by.join(", ")}`);
      if (n.crosses.length) out.push(`- crosses: ${n.crosses.join(", ")}`);
      if (n.references.length) out.push(`- references: ${n.references.join(", ")}`);
      if (n.anchors.length) out.push(`- anchors: ${n.anchors.join(", ")}`);
      if (n.scenarios.length) out.push(`- scenarios: ${n.scenarios.join(", ")}`);
      break;
    case "loop":
      out.push(`- boundary: ${n.boundary}`);
      out.push(`- owner: ${n.owner ?? "(none — dormant)"}`);
      if (n.anchors.length) out.push(`- anchors: ${n.anchors.join(", ")}`);
      if (n.scenarios.length) out.push(`- scenarios: ${n.scenarios.join(", ")}`);
      if (sn.effectiveConstraints?.length)
        out.push(`- effective constraints (applies_to): ${sn.effectiveConstraints.join(", ")}`);
      if (n.notes) out.push(`- notes: ${n.notes}`);
      break;
    case "junction":
      out.push(`- between: ${n.between.join(" → ")}`);
      if (n.scenarios.length) out.push(`- scenarios: ${n.scenarios.join(", ")}`);
      for (const e of n.evidence)
        out.push(`- evidence [${e.kind}] ${e.anchor}${e.note ? ` — ${e.note}` : ""}`);
      break;
    case "scenario":
      out.push(`- given: ${n.given}`);
      out.push(`- when: ${n.when}`);
      out.push(`- then: ${n.then}`);
      out.push(`- verified_by: ${scenarioTestAnchorLabels(n).join(", ") || "(none)"}`);
      if (n.applies_to)
        out.push(
          `- applies_to: nodes=[${n.applies_to.nodes.join(", ")}]${n.applies_to.owner_match ? ` owner_match="${n.applies_to.owner_match}"` : ""}`,
        );
      break;
    case "debt":
      out.push(`- reality: ${n.reality}`);
      if (n.claim) out.push(`- claim: ${n.claim}`);
      break;
    case "feature":
      if (n.contains.length) out.push(`- contains: ${n.contains.join(", ")}`);
      break;
  }
  return out;
}

/** Full side-channel body: banner + every node's complete detail, nothing truncated. */
export function renderSliceMarkdown(slice: ModelSlice, banner: string): string {
  const groups = groupByKind(slice.nodes);
  const lines: string[] = [
    banner,
    "",
    `# inspect ${slice.rootId} (${slice.rootKind}) — depth ${slice.maxDepth}`,
    "",
    `${slice.nodes.length} node(s) reached; ${slice.frontierPointers.length} pointer(s) at the frontier.`,
    "",
  ];

  for (const kind of KIND_ORDER) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    lines.push(`## ${kind} (${list.length})`, "");
    for (const sn of list) {
      lines.push(...renderNodeDetail(sn), "");
    }
  }

  if (slice.frontierPointers.length > 0) {
    lines.push(`## frontier (beyond depth ${slice.maxDepth} — re-run with --depth to expand)`, "");
    for (const p of slice.frontierPointers) {
      lines.push(`- ${p.id} (${p.kind}) — referenced by ${p.fromId}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
