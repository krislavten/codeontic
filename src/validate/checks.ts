import { basename } from "node:path";
import type { LoadResult } from "../loader/load-model.js";
import { type ModelGraph, allNodes } from "../loader/model-graph.js";
import { collectDanglingAppliesTo } from "../query/effective-constraints.js";
import { isGradedFlow, junctionEndpointKind, testTextAnchorLabel } from "../schema/model.js";
import { anchorFilePath, anchorSymbol, isValidAnchorFormat } from "./anchor.js";
import { resolveAnchorPresence } from "./presence.js";
import type { Violation } from "./types.js";

/** Schema-parse failures collected during loadModel become blocking violations. */
export function checkSchema(load: LoadResult): Violation[] {
  return load.parseErrors.map((e) => ({
    check: "schema",
    severity: "error",
    message: e.message,
    file: e.file,
  }));
}

/**
 * Advisory: a file-per-node file's name (minus extension) must equal the id of
 * the single node it holds (Decision 004 技术点 3 — promised for Phase 1,
 * delivered here in A7). Only single-node files are checked; array files that
 * group many nodes under a section name (loops/*.yaml) carry the section, not
 * an id, and are correctly exempt (see LoadResult.singleNodeFiles). Warning,
 * not error: a mismatch is a naming-hygiene slip a human should fix, not a
 * reason to fail a build (the model still loads correctly).
 */
export function checkFilenameMatchesId(load: LoadResult): Violation[] {
  const violations: Violation[] = [];
  for (const [file, id] of load.singleNodeFiles) {
    const stem = basename(file).replace(/\.(ya?ml)$/i, "");
    if (stem !== id) {
      violations.push({
        check: "filename-id",
        severity: "warning",
        message: `file-per-node file "${file}" holds node "${id}" but its filename stem is "${stem}" — rename to "${id}.yaml" (Decision 004 file-per-node convention)`,
        file,
        nodeId: id,
      });
    }
  }
  return violations;
}

/** Duplicate ids collected during loadModel become blocking violations. */
export function checkIdUniqueness(load: LoadResult): Violation[] {
  return load.duplicateIds.map((d) => ({
    check: "id-uniqueness",
    severity: "error",
    message: `id "${d.id}" is declared more than once, in: ${d.files.join(", ")}`,
    nodeId: d.id,
  }));
}

interface AnchoredNode {
  nodeId: string;
  anchor: string;
}

/**
 * Every anchor string a graph references, deduped — the exact input
 * `resolveAnchorPresence` needs. Exported so `conformance` resolves the SAME
 * anchor set `check` does instead of deriving its own (Proposal 016 T6).
 */
export function collectAnchorStrings(graph: ModelGraph): string[] {
  return [...new Set(collectAnchors(graph).map((a) => a.anchor))];
}

/** Every anchor string a graph references: Loop.anchors, Flow.anchors, Junction.evidence[].anchor, Scenario.verified_by[]. */
function collectAnchors(graph: ModelGraph): AnchoredNode[] {
  const out: AnchoredNode[] = [];
  for (const node of allNodes(graph)) {
    if (node.kind === "loop") {
      for (const anchor of node.anchors) out.push({ nodeId: node.id, anchor });
    } else if (node.kind === "flow") {
      for (const anchor of node.anchors) out.push({ nodeId: node.id, anchor });
    } else if (node.kind === "junction") {
      for (const evidence of node.evidence) out.push({ nodeId: node.id, anchor: evidence.anchor });
    } else if (node.kind === "scenario") {
      for (const anchor of node.verified_by) out.push({ nodeId: node.id, anchor });
    }
  }
  return out;
}

/** Blocking: every anchor must be syntactically well-formed (file#symbol or table[.column]). */
export function checkAnchorFormat(graph: ModelGraph): Violation[] {
  const violations: Violation[] = [];
  for (const { nodeId, anchor } of collectAnchors(graph)) {
    if (!isValidAnchorFormat(anchor)) {
      violations.push({
        check: "anchor-format",
        severity: "error",
        message: `anchor "${anchor}" on ${nodeId} is not a valid "path#symbol" or "table[.column]" anchor`,
        nodeId,
      });
    }
  }
  return violations;
}

interface ReferenceCheck {
  nodeId: string;
  targetId: string;
  targetKind: "feature" | "flow" | "loop" | "junction" | "scenario";
  field: string;
}

/**
 * Every id-shaped cross-reference a node carries, paired with which kind
 * it must resolve to. This is deliberately exhaustive over every
 * reference-shaped field in the schema (Flow.traverses/guarded_by/
 * references/crosses/scenarios, Junction.between/scenarios, Loop.parent/scenarios,
 * Feature.contains) — a reference field added to the schema later and
 * forgotten here would silently stop being checked, so keep this in sync
 * with src/schema/model.ts whenever a new reference field is added.
 */
function collectReferences(graph: ModelGraph): ReferenceCheck[] {
  const out: ReferenceCheck[] = [];
  for (const node of allNodes(graph)) {
    if (node.kind === "feature") {
      for (const id of node.contains)
        out.push({ nodeId: node.id, targetId: id, targetKind: "flow", field: "contains" });
    } else if (node.kind === "flow") {
      for (const id of node.traverses)
        out.push({ nodeId: node.id, targetId: id, targetKind: "loop", field: "traverses" });
      for (const id of node.guarded_by)
        out.push({ nodeId: node.id, targetId: id, targetKind: "loop", field: "guarded_by" });
      for (const id of node.references)
        out.push({ nodeId: node.id, targetId: id, targetKind: "flow", field: "references" });
      for (const id of node.crosses)
        out.push({ nodeId: node.id, targetId: id, targetKind: "junction", field: "crosses" });
      for (const id of node.scenarios)
        out.push({ nodeId: node.id, targetId: id, targetKind: "scenario", field: "scenarios" });
    } else if (node.kind === "loop") {
      if (node.parent)
        out.push({ nodeId: node.id, targetId: node.parent, targetKind: "loop", field: "parent" });
      for (const id of node.scenarios)
        out.push({ nodeId: node.id, targetId: id, targetKind: "scenario", field: "scenarios" });
    } else if (node.kind === "junction") {
      // `between` endpoints may be loops OR flows since Proposal 016 T4. The
      // expected kind comes from the id's own shape (junctionEndpointKind —
      // total, because the schema union already accepted the string as one of
      // the two disjoint forms), so a dangling `C99` is reported as a missing
      // flow rather than a confusing "not a defined loop".
      for (const id of node.between)
        out.push({
          nodeId: node.id,
          targetId: id,
          targetKind: junctionEndpointKind(id),
          field: "between",
        });
      for (const id of node.scenarios)
        out.push({ nodeId: node.id, targetId: id, targetKind: "scenario", field: "scenarios" });
    }
  }
  return out;
}

/**
 * Blocking: every cross-node reference (Flow.traverses, Junction.between,
 * Loop.parent, etc.) must resolve to an actual node of the expected kind
 * in the loaded graph. This is pure set-membership over an already-loaded
 * graph — no I/O, no AST — so it stays within T0's cost budget despite
 * catching what would otherwise be a silent dangling/typo'd reference
 * (e.g. a Flow.traverses entry that matches the LoopId regex shape but
 * names a Loop that was never actually defined).
 */
export function checkReferentialIntegrity(graph: ModelGraph): Violation[] {
  const violations: Violation[] = [];
  for (const { nodeId, targetId, targetKind, field } of collectReferences(graph)) {
    if (!graph.byKind[targetKind].has(targetId)) {
      violations.push({
        check: "referential-integrity",
        severity: "error",
        message: `${nodeId}.${field} references "${targetId}", which is not a defined ${targetKind}`,
        nodeId,
      });
    }
  }
  // Scenario.applies_to.nodes is checked separately: unlike every other
  // reference field, it's valid against ANY of the 6 kinds (Decision
  // record 004, 技术点 2), so it doesn't fit collectReferences' one-
  // targetKind-per-field shape.
  for (const { scenarioId, targetId } of collectDanglingAppliesTo(graph)) {
    violations.push({
      check: "referential-integrity",
      severity: "error",
      message: `${scenarioId}.applies_to.nodes references "${targetId}", which is not a defined node of any kind`,
      nodeId: scenarioId,
    });
  }
  return violations;
}

/**
 * Standard DFS back-edge cycle detection over a directed adjacency map.
 * Returns every distinct cycle found, each as a node-id path that starts
 * and ends on the same id (e.g. ["L1a", "L1b", "L1a"]). Duplicate
 * reports of the same cycle entered from different starting nodes are
 * collapsed by rotating each cycle to start at its lexicographically
 * smallest id before deduping.
 */
function findCycles(adjacency: Map<string, string[]>): string[][] {
  const color = new Map<string, "gray" | "black">();
  const stack: string[] = [];
  const found: string[][] = [];

  function visit(node: string): void {
    color.set(node, "gray");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (color.get(next) === "gray") {
        const idx = stack.indexOf(next);
        found.push([...stack.slice(idx), next]);
      } else if (color.get(next) !== "black") {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, "black");
  }

  for (const node of adjacency.keys()) {
    if (!color.has(node)) visit(node);
  }

  const seen = new Set<string>();
  const deduped: string[][] = [];
  for (const cycle of found) {
    const ring = cycle.slice(0, -1); // drop the repeated closing id
    let minIdx = 0;
    for (let i = 1; i < ring.length; i++) {
      const candidate = ring[i];
      const current = ring[minIdx];
      if (candidate !== undefined && current !== undefined && candidate < current) minIdx = i;
    }
    const canonical = [...ring.slice(minIdx), ...ring.slice(0, minIdx)];
    const key = canonical.join("->");
    if (seen.has(key)) continue;
    seen.add(key);
    const first = canonical[0];
    if (first === undefined) continue; // ring/canonical structurally non-empty; guard, not assertion
    deduped.push([...canonical, first]);
  }
  return deduped;
}

interface CycleEdgeSpec {
  field: string;
  /** Every same-kind id this node points at via this field. */
  targets: (nodeId: string, graph: ModelGraph) => string[];
}

/**
 * The only two fields in the schema that can form a cycle: `Loop.parent`
 * and `Flow.references` both point at their own kind. Every other
 * reference field is a bipartite edge into a different kind with no edge
 * pointing back (see checkGraphAcyclic's docstring for the full
 * argument), so a cycle is structurally impossible through them today.
 * Adding ANY new node-reference field to the schema — same-kind or
 * cross-kind — requires re-deriving that argument from scratch and
 * updating this list if it turns out to close a cycle.
 */
const CYCLE_EDGE_SPECS: Record<"loop" | "flow", CycleEdgeSpec> = {
  loop: {
    field: "parent",
    targets: (nodeId, graph) => {
      const parent = graph.byKind.loop.get(nodeId)?.parent;
      return parent ? [parent] : [];
    },
  },
  flow: {
    field: "references",
    targets: (nodeId, graph) => graph.byKind.flow.get(nodeId)?.references ?? [],
  },
};

/**
 * Blocking: neither `Loop.parent` nor `Flow.references` may form a
 * cycle. These are the only two same-kind reference fields in the schema.
 *
 * Cross-kind edges are NOT cycle-checked, and since Proposal 016 T4 that is a
 * deliberate choice rather than a structural impossibility: `Junction.between`
 * now accepts flow ids, so `Flow.crosses -> Junction -> Flow(between)` closes a
 * two-kind ring. That ring is exactly what a correctly modeled flow-level
 * handoff looks like — C1 crosses J-x, and J-x names C1 as one of its
 * endpoints — so reporting it would fail every model that uses the new
 * expressiveness. Every REMAINING cross-kind edge (Flow.traverses/guarded_by,
 * Junction.between->loop, Loop.scenarios, Feature.contains, every `scenarios`
 * field) still runs into a kind carrying no reference field pointing back
 * (Scenario has no node-reference outputs at all; Loop's only outputs are
 * `parent` and `scenarios`; Feature's only output is `contains`), so no other
 * cross-kind ring exists today. This is a claim about today's schema shape, not
 * a structural guarantee: adding any new node-reference field (same-kind OR
 * cross-kind) invalidates it and requires re-deriving both which edges can now
 * close a ring and, for each new ring, whether it is a defect or legitimate
 * modeling.
 */
export function checkGraphAcyclic(graph: ModelGraph): Violation[] {
  const violations: Violation[] = [];
  for (const [kind, spec] of Object.entries(CYCLE_EDGE_SPECS) as [
    "loop" | "flow",
    CycleEdgeSpec,
  ][]) {
    const adjacency = new Map<string, string[]>();
    for (const id of graph.byKind[kind].keys()) {
      adjacency.set(id, spec.targets(id, graph));
    }
    for (const cycle of findCycles(adjacency)) {
      const nodeId = cycle[0]; // findCycles never returns an empty ring; guard rather than assert
      if (nodeId === undefined) continue;
      violations.push({
        check: "graph-acyclic",
        severity: "error",
        message: `${kind}.${spec.field} forms a cycle: ${cycle.join(" -> ")}`,
        nodeId,
      });
    }
  }
  return violations;
}

/**
 * Rule 1 of the `shape` contract (Proposal 012 §2.2): a flow declared
 * `composed` must not carry `anchors`.
 *
 * ERROR, not warning, and deliberately so — unlike `flow-scenario-ignored`,
 * which stays advisory because the model there is well-formed and the grading
 * RULE may be what needs to change. Here the two statements contradict each
 * other: `composed` means "I hold no implementation of my own; grade my parts
 * instead", and anchors say the opposite. The two readings produce opposite
 * grading (excluded vs graded `met`), so silently picking one is the engine
 * guessing again — the entire thing `shape` exists to stop.
 *
 * This does NOT block incremental adoption: `shape` is optional, so a model
 * that never declares it can never trip this check. Only a flow that
 * explicitly claims `composed` AND carries anchors does, and the fix is one
 * word. An error is affordable precisely because it is unreachable by accident.
 */
export function checkFlowShapeConsistency(graph: ModelGraph): Violation[] {
  const violations: Violation[] = [];
  for (const flow of graph.byKind.flow.values()) {
    if (flow.shape !== "composed" || flow.anchors.length === 0) continue;
    violations.push({
      check: "flow-shape",
      severity: "error",
      message: `flow ${flow.id} is declared shape: composed but carries anchors (${flow.anchors.join(", ")}) — a composed flow holds no implementation of its own; either drop the anchors or declare shape: anchored`,
      nodeId: flow.id,
    });
  }
  return violations;
}

/**
 * A composition-only flow (no own `anchors`, composes other model nodes) is
 * deliberately kept OUT of conformance grading — its constituent loops are
 * already graded, and grading it too would double-count their green. The
 * consequence is that any `scenarios` such a flow declares are never evaluated:
 * they neither lift the flow's verdict (it has none) nor guard its loops (which
 * only see their own `scenarios`).
 *
 * Left silent, that is a trap: the author attaches a real, verified GWT at the
 * flow level, `check` passes, and conformance still reports the traversed loops
 * as `unguarded (no scenario)`. The loop report is not itself wrong — a loop
 * with no own scenarios has always said that — but the flow-level attachment
 * creates a NEW way to believe you have closed a gap you have not. So say it.
 *
 * WARNING, not error: the model is not malformed, and the fix may well be to
 * change the grading rule rather than the model. Whether own-scenarios should
 * opt a flow INTO grading (symmetrically with own-anchors) is the open question
 * tracked in the Flow-first-class alignment issue; until that is decided this
 * check refuses to let the case pass unnoticed.
 */
export function checkFlowScenarioIgnored(graph: ModelGraph): Violation[] {
  const violations: Violation[] = [];
  for (const flow of graph.byKind.flow.values()) {
    // Same predicate conformance grades on — shared, not re-derived, so the
    // warning can never disagree with the exclusion that causes it.
    if (isGradedFlow(flow) || flow.scenarios.length === 0) continue;
    violations.push({
      check: "flow-scenario-ignored",
      severity: "warning",
      message: `flow ${flow.id} declares scenarios (${flow.scenarios.join(", ")}) but has no own anchors, so it is excluded from conformance grading and those scenarios are never evaluated — give the flow its own anchors to have them count, or move them onto the loops they guard`,
      nodeId: flow.id,
    });
  }
  return violations;
}

/**
 * Advisory by default: does the anchored file exist under `repoRoot`, and does
 * that file still declare the anchored symbol?
 *
 * Two tiers, deliberately different severities:
 *
 *  - FILE missing → `severity` (warning, or error under `strict`). A target
 *    repo's HEAD legitimately moves past the commit a model was authored
 *    against; treat it as "investigate: mis-encoded vs. code moved on".
 *  - SYMBOL missing → always a warning, never promoted by `strict`. The file
 *    is right and only the name is stale: that is a nudge, not a stop-the-line
 *    event, and the lookup behind it is text-level (see symbol.ts) so it is the
 *    tier likeliest to be imprecise. Promoting it under `strict` would turn a
 *    repo's first upgrade into a red gate over bookkeeping.
 *
 * WHAT NEITHER TIER CATCHES, and why the loop-mechanism check exists: an
 * anchor can point at a file that exists, name a symbol that exists, and still
 * describe behaviour that has moved away. Splitting a god-file typically
 * leaves a one-line delegating wrapper behind (`return this.sandbox.start(id)`)
 * — file present, symbol present, timer gone. Both tiers here stay green. See
 * `checkLoopMechanism`.
 */
export async function checkAnchorExistence(
  graph: ModelGraph,
  repoRoot: string,
  options: { strict?: boolean | undefined; fileSet?: ReadonlySet<string> | undefined } = {},
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const severity = options.strict ? "error" : "warning";
  const anchors = collectAnchors(graph);
  // One filesystem pass, shared verbatim with `conformance` (presence.ts) so
  // the checker and the report card can never disagree about which anchors
  // still resolve — Proposal 016 T6/D1.
  const presence = await resolveAnchorPresence(repoRoot, {
    anchors: anchors.map((a) => a.anchor),
    fileSet: options.fileSet,
  });

  for (const { nodeId, anchor } of anchors) {
    const filePath = anchorFilePath(anchor);
    if (!filePath) continue; // table-style anchors have no file to check
    if (!presence.existingFiles.has(filePath)) {
      violations.push({
        check: "anchor-existence",
        severity,
        message: `anchor "${anchor}" on ${nodeId} points at "${filePath}", which does not exist under ${repoRoot}`,
        nodeId,
      });
      continue;
    }
    if (presence.staleSymbolAnchors.has(anchor)) {
      const symbol = anchorSymbol(anchor) ?? "";
      violations.push({
        check: "anchor-symbol",
        severity: "warning",
        message: `anchor "${anchor}" on ${nodeId}: "${filePath}" exists but no longer mentions "${symbol.split(".")[0]}" anywhere — the file is right and the name is stale (renamed, or the code moved elsewhere)`,
        nodeId,
      });
    }
  }
  return violations;
}

/**
 * The text-anchor half of `verified_by` (schema `TestTextAnchor`): does the
 * quoted test title still appear in the file that claims to hold it?
 *
 * Two tiers with different severities, drawn exactly where
 * `checkAnchorExistence` draws them — the notation an author picked must never
 * change how strict the gate is:
 *
 *  - FILE missing → `severity` (error under `strict`). A path that resolves to
 *    nothing is a hard fact with no false-negative risk, in either anchor form.
 *    Leaving this a warning would mean rewriting one entry from `path#symbol`
 *    to `{file, text}` quietly excused a missing test file from the gate.
 *  - TEXT not found → ALWAYS a warning, never promoted, same as `crux`. Here
 *    the evidence is text matching, whose false-negative rate on a legitimate
 *    reword must stay cheap; this form exists precisely so an author can name a
 *    test honestly instead of underscoring its title into a symbol that was
 *    never in the file, and punishing that with a red build would undo it. The
 *    report card consumes the same result (conformance stops counting a
 *    scenario whose test anchor went stale), which is where the consequence
 *    belongs: gate lenient, score honest.
 *
 * `anchor-crux` rather than a new check name, deliberately: it is the same
 * mechanism on a different field, and a reader who has muted or triaged
 * "crux text moved" wants this in the same bucket.
 */
export async function checkVerifiedByText(
  graph: ModelGraph,
  repoRoot: string,
  options: { strict?: boolean | undefined; fileSet?: ReadonlySet<string> | undefined } = {},
): Promise<Violation[]> {
  const scenarios = [...graph.byKind.scenario.values()].filter(
    (s) => s.verified_by_text.length > 0,
  );
  if (scenarios.length === 0) return [];

  const presence = await resolveAnchorPresence(repoRoot, {
    fileSet: options.fileSet,
    anchors: [],
    textAnchors: scenarios.flatMap((s) => s.verified_by_text),
  });

  const violations: Violation[] = [];
  const severity = options.strict ? "error" : "warning";
  for (const scenario of scenarios) {
    for (const anchor of scenario.verified_by_text) {
      if (!presence.existingFiles.has(anchor.file)) {
        violations.push({
          check: "anchor-existence",
          severity,
          message: `verified_by text anchor on ${scenario.id} points at "${anchor.file}", which does not exist under ${repoRoot}`,
          nodeId: scenario.id,
        });
        continue;
      }
      if (presence.staleTextAnchors.has(testTextAnchorLabel(anchor))) {
        violations.push({
          check: "anchor-crux",
          severity: "warning",
          message: `verified_by text "${anchor.text}" on ${scenario.id} no longer appears in ${anchor.file} — the test was renamed or removed; update the model or restore the test`,
          nodeId: scenario.id,
        });
      }
    }
  }
  return violations;
}
