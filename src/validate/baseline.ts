import type { Violation } from "./types.js";

/**
 * Debt baseline is allowed to shrink (pay off debt) but never grow: a PR
 * must not introduce a debt id that wasn't already in the baseline it's
 * diffing against. Content edits to *existing* ids (e.g. clarifying the
 * `reality` text) are intentionally not checked here — judging whether a
 * wording change "扩大了既有债务" is a semantic call, not a mechanical
 * one, and belongs to human review, not T0.
 */
export function checkBaselineOnlyDecreases(before: Set<string>, after: Set<string>): Violation[] {
  const added = [...after].filter((id) => !before.has(id));
  return added.map((id) => ({
    check: "baseline-growth",
    severity: "error",
    message: `debt baseline grew: "${id}" is new and was not in the prior baseline; new debt must be paid down, not registered as baseline`,
    nodeId: id,
  }));
}
