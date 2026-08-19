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
  | "freetext-id-ref"
  /**
   * Not a check over the model — the finding that `.codeontic/config.json`
   * itself is unreadable, so the layer it configures never ran. It gets its own
   * name because "INV-1 found a bad write site" and "INV-1 could not start" call
   * for opposite actions, and because the gate compares findings by name: with
   * this one distinct, a config already broken on the trunk compares equal
   * across the two sides instead of being blamed on the next PR.
   */
  | "codeontic-config"
  /**
   * A check that ran at the base ref and does NOT run here — the config it
   * needed was deleted, the model it examined is empty. Distinct from every
   * other name because the thing to fix is neither the model nor a finding:
   * it is that this change removed the ability to look.
   */
  | "coverage-regression";

export interface Violation {
  check: CheckName;
  severity: Severity;
  message: string;
  file?: string;
  nodeId?: string;
  /**
   * Stable identity for "is this the SAME finding as that one", across two
   * trees. Optional: when absent, comparers fall back to the message, which is
   * right for findings whose text is fully determined by the model.
   *
   * It exists because some messages carry position (`file.ts:42`), and position
   * moves for reasons that are not the finding: adding an unrelated import one
   * line above a long-standing INV-1 violation would otherwise make it read as
   * newly introduced, and block a PR that introduced nothing. Only the check
   * that produced a finding knows which parts of its text are the finding and
   * which are where it happened to be today.
   */
  identity?: string;
}

export interface T0Result {
  /** true iff there are no error-severity violations (warnings don't fail T0). */
  ok: boolean;
  violations: Violation[];
}

export function summarize(violations: Violation[]): T0Result {
  return { ok: violations.every((v) => v.severity !== "error"), violations };
}
