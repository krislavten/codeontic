import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelGraph } from "../loader/model-graph.js";
import { anchorFilePath } from "./anchor.js";
import { isParseableSource } from "./symbol.js";
import type { Violation } from "./types.js";

const MAX_SYMBOL_SCAN_BYTES = 2_000_000;

/**
 * Strip all whitespace for fuzzy crux matching. This lets a crux survive
 * pure-formatting changes (re-indentation, brace-spacing, trailing spaces)
 * without false negatives.
 */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * The two-tier crux match itself, extracted so `verified_by`'s text anchors
 * (schema `TestTextAnchor`) run the SAME matcher rather than a second one that
 * could drift from it — the two features make the same promise to the author
 * ("this text is still in that file"), so they must agree on what that means.
 *   1. exact substring of the raw text;
 *   2. whitespace-stripped substring — survives re-indentation and reflow.
 */
export function fileContainsCruxText(content: string, text: string): boolean {
  if (content.includes(text)) return true;
  return stripWhitespace(content).includes(stripWhitespace(text));
}

/**
 * Check that every `crux[].text` still appears in its anchored file
 * (Proposal 013 B2). Two-tier matching:
 *   1. Exact substring match of the raw `text` in the file content.
 *   2. Whitespace-normalized match (both sides trimmed per line, internal
 *      whitespace collapsed) — survives pure formatting changes.
 *
 * Always a warning, never promoted by `--strict-anchors` — same posture
 * as anchor-symbol, for the same reason: text matching's false-negative
 * rate on legitimate refactors must stay cheap.
 *
 * The referential half — each crux's `anchor` must be one of the node's own
 * `anchors` — lives in `checkCruxReferences` below, because it is a property of
 * the MODEL ALONE and must run even when there is no checkout to read.
 */
export async function checkAnchorCrux(graph: ModelGraph, repoRoot: string): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const node of [...graph.byKind.loop.values(), ...graph.byKind.flow.values()]) {
    if (!node.crux || node.crux.length === 0) continue;

    const nodeAnchors = new Set(node.anchors);

    for (const crux of node.crux) {
      if (!nodeAnchors.has(crux.anchor)) {
        // Reported by checkCruxReferences, which runs unconditionally.
        continue;
      }
      const filePath = anchorFilePath(crux.anchor);
      if (!filePath) continue;
      if (!isParseableSource(filePath)) continue;

      const absolute = join(repoRoot, filePath);
      const size = await stat(absolute)
        .then((s) => s.size)
        .catch(() => Number.POSITIVE_INFINITY);
      if (size > MAX_SYMBOL_SCAN_BYTES) continue;

      const content = await readFile(absolute, "utf8").catch(() => undefined);
      if (content === undefined) continue;

      if (fileContainsCruxText(content, crux.text)) continue;

      violations.push({
        check: "anchor-crux",
        severity: "warning",
        message: `crux text on ${node.id} no longer found in ${filePath} — behavior may have moved; update the model or restore the code`,
        nodeId: node.id,
      });
    }
  }

  return violations;
}

/**
 * The crux check's MODEL-ONLY half: every `crux.anchor` must be one of the
 * node's own `anchors`.
 *
 * Split out of `checkAnchorCrux` because that one needs a checkout to read
 * file contents, and T0 therefore only calls it when a repoRoot is given. This
 * half needs nothing but the graph — leaving it in there meant
 * `gate --model-only` printed "no MODEL errors" while a model-level
 * inconsistency sat right there, and the same tree failed as soon as a
 * repoRoot was passed.
 */
export function checkCruxReferences(graph: ModelGraph): Violation[] {
  const violations: Violation[] = [];
  for (const node of [...graph.byKind.loop.values(), ...graph.byKind.flow.values()]) {
    if (!node.crux || node.crux.length === 0) continue;
    const nodeAnchors = new Set(node.anchors);
    for (const crux of node.crux) {
      if (nodeAnchors.has(crux.anchor)) continue;
      violations.push({
        check: "anchor-crux",
        severity: "error",
        message: `${node.id}.crux references anchor "${crux.anchor}" which is not in ${node.id}.anchors — crux is a refinement of an existing anchor`,
        nodeId: node.id,
      });
    }
  }
  return violations;
}
