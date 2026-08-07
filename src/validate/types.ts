/**
 * `"info"` is not a defect tier — it never fails anything, `summarize()`
 * below treats it exactly like `"warning"` (both `!== "error"`). It exists so
 * a check can report a POSITIVE finding (e.g. "verified via delegation") that
 * would otherwise be indistinguishable from "nothing to say" — an empty
 * violations array from a check that ran and found a delegation hop reads
 * identically to one from a check that never ran at all. See mechanism.ts.
 */
export type Severity = "error" | "warning" | "info";

export type CheckName =
  | "schema"
  | "id-uniqueness"
  | "anchor-format"
  | "anchor-existence"
  | "anchor-symbol"
  | "anchor-crux"
  | "loop-mechanism"
  | "referential-integrity"
  | "graph-acyclic"
  | "baseline-growth"
  | "inv1-write-site"
  | "filename-id"
  | "flow-scenario-ignored"
  | "flow-shape"
  // Cross-node consistency (Proposal 016 T3, src/validate/consistency.ts).
  | "anchor-duplicate"
  | "freetext-id-ref";

export interface Violation {
  check: CheckName;
  severity: Severity;
  message: string;
  file?: string;
  nodeId?: string;
}

export interface T0Result {
  /** true iff there are no error-severity violations (warnings don't fail T0). */
  ok: boolean;
  violations: Violation[];
}

export function summarize(violations: Violation[]): T0Result {
  return { ok: violations.every((v) => v.severity !== "error"), violations };
}
