import { join } from "node:path";
import { loadModel } from "../../loader/load-model.js";
import { type Coverage, computeCoverage } from "../../query/coverage.js";

export type CoverageResult =
  | { ran: true; coverage: Coverage }
  | { ran: false; skippedReason: string };

/**
 * `codeontic coverage`: report how much of the model is directly bound to
 * anchors/scenarios (see src/query/coverage.ts for why "directly").
 *
 * This command shares an advisory CI job with `check` — which is the command
 * whose job it is to FAIL on a broken model — so it never exits non-zero and
 * never refuses to report just because `check` will also complain. But "don't
 * fail" must not become "report a number that isn't true:
 *
 * - Model dir missing/unreadable → `ran: false`. Reported as a skip, never as
 *   "0% coverage", which reads as a real (and alarming) measurement of a model
 *   that simply wasn't found.
 * - EVERY file failed to parse → also `ran: false`, for the same reason. The
 *   dir existing doesn't make `0/0` a measurement. (`findYamlFiles` only throws
 *   on readdir errors; per-file YAML/schema failures land in `parseErrors` and
 *   would otherwise sail straight past the catch below.)
 * - SOME files failed to parse → report, but carry the count through so the
 *   output can say so. Partial loading does NOT simply "depress coverage":
 *   dropping unanchored loops shrinks the denominator and can push the reported
 *   percentage UP (measured: one broken file moved 27/67=40% to 26/57=46%).
 */
export async function runCoverage(targetDir: string): Promise<CoverageResult> {
  let load: Awaited<ReturnType<typeof loadModel>>;
  try {
    load = await loadModel(join(targetDir, ".codeontic", "model"));
  } catch (err) {
    return { ran: false, skippedReason: err instanceof Error ? err.message : String(err) };
  }

  const parseErrors = load.parseErrors.length;
  if (parseErrors > 0 && load.entries.length === 0) {
    return {
      ran: false,
      skippedReason: `all ${parseErrors} model file(s) failed to parse — run "codeontic check" for the errors`,
    };
  }

  return { ran: true, coverage: computeCoverage(load.graph, parseErrors) };
}
