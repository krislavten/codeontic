import type { LoadResult } from "../loader/load-model.js";
import {
  checkAnchorExistence,
  checkAnchorFormat,
  checkFilenameMatchesId,
  checkFlowScenarioIgnored,
  checkFlowShapeConsistency,
  checkGraphAcyclic,
  checkIdUniqueness,
  checkReferentialIntegrity,
  checkSchema,
  checkVerifiedByText,
} from "./checks.js";
import { checkAnchorDuplicate, checkFreetextIdRef } from "./consistency.js";
import { checkAnchorCrux, checkCruxReferences } from "./crux.js";
import { summarize } from "./types.js";
import type { T0Result, Violation } from "./types.js";

export interface T0Options {
  /**
   * Absolute path to the repo the anchors should resolve against.
   * Omit to skip anchor-existence entirely (format-only checking) — the
   * right default when there's no target repo checked out yet, e.g. in
   * codeontic's own CI which only tests the engine against fixtures.
   */
  repoRoot?: string | undefined;
  /** Promote anchor-existence to a blocking check. Default: advisory (warning). */
  strictAnchorExistence?: boolean | undefined;
}

/**
 * Runs the full T0 layer: schema validity, id uniqueness, file-per-node
 * filename==id (advisory), cross-node referential integrity, graph acyclicity
 * (Loop.parent / Flow.references — the only two same-kind reference fields, see
 * checkGraphAcyclic), anchor format, cross-node consistency (duplicate anchor
 * claims / dangling free-text id references, both advisory), and (optionally)
 * anchor existence.
 * Deliberately
 * excludes: INV-1's whole-repo AST writer scan, T1's queue-derivation-
 * chain check, and anything baseline-growth related (that needs a
 * two-snapshot diff, see checkBaselineOnlyDecreases — it's not part of a
 * single-snapshot T0 run). All of T0 must stay cheap and deterministic:
 * no network calls, no LLM.
 */
export async function runT0(load: LoadResult, options: T0Options = {}): Promise<T0Result> {
  const violations: Violation[] = [
    ...checkSchema(load),
    ...checkIdUniqueness(load),
    ...checkFilenameMatchesId(load),
    ...checkReferentialIntegrity(load.graph),
    ...checkGraphAcyclic(load.graph),
    ...checkAnchorFormat(load.graph),
    ...checkFlowScenarioIgnored(load.graph),
    ...checkFlowShapeConsistency(load.graph),
    // Cross-node consistency (Proposal 016 T3) — both advisory, both pure
    // functions of the loaded graph. See consistency.ts for why each is a
    // warning and what each deliberately does not look at.
    ...checkAnchorDuplicate(load.graph),
    ...checkFreetextIdRef(load.graph),
    // Model-only, so it runs with or without a checkout — see crux.ts.
    ...checkCruxReferences(load.graph),
  ];

  if (options.repoRoot) {
    violations.push(
      ...(await checkAnchorExistence(load.graph, options.repoRoot, {
        strict: options.strictAnchorExistence,
      })),
      ...(await checkAnchorCrux(load.graph, options.repoRoot)),
      ...(await checkVerifiedByText(load.graph, options.repoRoot, {
        strict: options.strictAnchorExistence,
      })),
    );
  }

  return summarize(violations);
}
