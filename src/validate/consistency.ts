import { type ModelGraph, allNodes } from "../loader/model-graph.js";
import type { ModelNode } from "../schema/index.js";
import { anchorSymbol } from "./anchor.js";
import type { Violation } from "./types.js";

/**
 * Cross-node consistency (Proposal 016 T3). Every other check in this layer
 * asks "is this ONE node well-formed?"; these two ask "do the nodes agree with
 * each other?" — the blind spot that made both of the incidents below survive
 * human review at 60-node scale.
 *
 * Same cost budget as the rest of T0: pure functions of the already-loaded
 * graph. No file I/O, no AST, no network, no LLM.
 */

/**
 * Advisory: the same `path#symbol` anchor claimed by two or more nodes.
 *
 * An anchor on a loop or a flow is an OWNERSHIP claim — "this node is the
 * model's account of that code". Two nodes claiming one symbol means the same
 * behaviour got modeled twice, and conformance then grades it twice. Proposal
 * 016 D8: a parallel-modeling run filed one compaction behaviour as both L4 and
 * L10 (`agent-session.ts#_checkCompaction` appearing under each), `check` said
 * nothing, and a human found it with `uniq -c`.
 *
 * `Junction.evidence[].anchor` is deliberately OUT of scope. A junction cites
 * code as proof that a risk exists at a seam; the code it cites belongs to the
 * loops/flows on either side BY DESIGN, so overlap there is the intended shape,
 * not a duplicate claim. `Scenario.verified_by` is out for the same reason —
 * one test legitimately verifies several scenarios.
 *
 * WARNING, not error. Duplication is a modeling judgement: a shared entry point
 * genuinely claimed by two behaviours is rare but real, and the merge decision
 * (fold the nodes, or narrow each anchor) belongs to a human — Proposal 016's
 * 不做清单 rules out automatic merging precisely because this class of mistake
 * enters silently. An existing model must not turn red on upgrade over
 * something that has always been true of it.
 *
 * Matching is on the EXACT anchor string. Two spellings of one symbol
 * (`a.ts#foo` vs `a.ts#Klass.foo`) are not folded together: normalising would
 * mean guessing at symbol identity, and this check's whole value is that it
 * never guesses.
 *
 * TABLE-STYLE anchors (`sessions`, `jobs_table.payload` — the `#`-less form
 * anchor.ts allows) are skipped for the same reason junction evidence is. A
 * function is written once and belongs to one behaviour; a TABLE is read and
 * written by many, so two loops naming `sessions.status` is ordinary rather
 * than duplicate modeling. Only a `path#symbol` anchor carries the ownership
 * claim this check is about.
 */
export function checkAnchorDuplicate(graph: ModelGraph): Violation[] {
  // anchor → the node ids claiming it. A Set because one node listing the same
  // anchor twice is a single claim, not a cross-node duplicate.
  const claimants = new Map<string, Set<string>>();
  for (const node of allNodes(graph)) {
    if (node.kind !== "loop" && node.kind !== "flow") continue;
    for (const anchor of node.anchors) {
      if (anchorSymbol(anchor) === undefined) continue; // table anchor — shared by design
      const ids = claimants.get(anchor) ?? new Set<string>();
      ids.add(node.id);
      claimants.set(anchor, ids);
    }
  }

  const violations: Violation[] = [];
  // Sorted twice over — anchors, then the ids inside each message — so the
  // report is stable across runs and Map insertion order never leaks out.
  for (const anchor of [...claimants.keys()].sort()) {
    const ids = [...(claimants.get(anchor) ?? [])].sort();
    const first = ids[0];
    if (ids.length < 2 || first === undefined) continue;
    violations.push({
      check: "anchor-duplicate",
      severity: "warning",
      message: `anchor "${anchor}" is claimed by ${ids.length} nodes (${ids.join(", ")}) — the same behaviour is modeled more than once, so conformance grades it more than once; fold the nodes together or narrow each anchor`,
      // The subject here is the anchor, not one node. `nodeId` carries the
      // first claimant so the violation is still attributable to somewhere in
      // the model, and every id involved is named in the message.
      nodeId: first,
    });
  }
  return violations;
}

/**
 * Node ids as they appear in prose, as ONE alternation ordered longest-form
 * first.
 *
 * A single combined regex, not six independent ones, because the forms nest:
 * `GWT-L99-001` would otherwise report twice (the inner `L99` sits between two
 * hyphens, so a standalone `\bL99\b` matches it happily). Scanning
 * left-to-right with the long forms first lets the outer match consume the
 * inner one.
 *
 * The trailing guard on the hyphenated forms is `(?![\w-])` rather than `\b`:
 * after a greedy `[a-z0-9_-]+` a `\b` can be satisfied mid-token and hand back
 * a truncated id.
 *
 * `DEBT-[A-Z0-9-]+` is narrower than `DebtId`'s `[A-Za-z0-9-]` on purpose:
 * every debt id in practice is upper-case, and admitting lower-case here would
 * swallow ordinary hyphenated prose following a literal "DEBT-". The cost is a
 * lower-case debt id going unchecked — the quieter of the two failure modes.
 */
const ID_TOKEN =
  /\bGWT-[A-Za-z0-9]+-\d{3}(?![\w-])|\bDEBT-[A-Z0-9-]+(?![\w-])|\bJ-[a-z0-9_-]+(?![\w-])|\b[LN]\d{1,2}[a-z]?\b|\bC\d+\b/g;

/**
 * The prose fields scanned for id mentions, per kind.
 *
 * Proposal 016 T3 names "notes/boundary/summary", but Junction and Debt carry
 * no field by any of those names — read literally, two of the four kinds the
 * proposal lists would contribute nothing. Read as "the free-text fields", this
 * table is the honest expansion: every field on these kinds whose content is
 * prose one human writes for another.
 *
 * `Evidence.note` is excluded even though it is free text. The schema holds it
 * to pointer-not-narrative discipline and caps it at 200 chars, so what it
 * actually carries is symbol and line-range fragments — scanning it buys false
 * positives and no incidents.
 */
function proseFields(node: ModelNode): { field: string; text: string }[] {
  switch (node.kind) {
    case "loop":
      return [
        { field: "boundary", text: node.boundary },
        ...(node.notes ? [{ field: "notes", text: node.notes }] : []),
      ];
    case "flow":
      return [
        ...(node.summary ? [{ field: "summary", text: node.summary }] : []),
        ...(node.risk_notes ? [{ field: "risk_notes", text: node.risk_notes }] : []),
      ];
    case "junction":
      return node.title ? [{ field: "title", text: node.title }] : [];
    case "debt":
      return [
        { field: "reality", text: node.reality },
        ...(node.claim ? [{ field: "claim", text: node.claim }] : []),
        ...(node.removal_condition
          ? [{ field: "removal_condition", text: node.removal_condition }]
          : []),
      ];
    default:
      return [];
  }
}

/**
 * Advisory: an id-shaped token in prose that names no node in this model.
 *
 * Free text is the one place a cross-reference is written with no schema behind
 * it, so nothing catches it going stale. Proposal 016 D10: a loop's `notes`
 * said "见 L4 auto-retry-backoff" about behaviour that actually lived in L3. It
 * survived two rounds of review, and when an unrelated L4 was later added the
 * error got WORSE — from pointing at nothing to pointing at the wrong node.
 * (This check cannot catch that second stage, by construction: L4 exists. It
 * catches the window in which the reference is still dangling, which is when
 * the fix is cheap.)
 *
 * KNOWN FALSE POSITIVES, accepted deliberately. This is a text scan with no
 * notion of what a sentence is about: "C1" in prose may be a hardware pin, a
 * column name or a path fragment, and each of those reports. Telling them apart
 * needs an LLM, which the engine's zero-LLM/zero-network rule forbids — and a
 * check that stays silent on real stale references is worth less than one that
 * occasionally names an innocent token. Hence WARNING and never error: a false
 * positive costs a reader one glance, and nothing turns red.
 */
export function checkFreetextIdRef(graph: ModelGraph): Violation[] {
  const nodes = allNodes(graph);
  const known = new Set(nodes.map((n) => n.id));

  const violations: Violation[] = [];
  for (const node of nodes) {
    for (const { field, text } of proseFields(node)) {
      // Deduped per field: one paragraph naming a stale id three times is one
      // finding, not three. Sorted for a stable report.
      const unknown = new Set<string>();
      for (const match of text.matchAll(ID_TOKEN)) {
        if (!known.has(match[0])) unknown.add(match[0]);
      }
      for (const token of [...unknown].sort()) {
        violations.push({
          check: "freetext-id-ref",
          severity: "warning",
          message: `${node.id}.${field} mentions "${token}", which is not a node in this model — a free-text cross-reference pointing at nothing (or an id-shaped word this text scan cannot tell apart from one)`,
          nodeId: node.id,
        });
      }
    }
  }
  return violations;
}
