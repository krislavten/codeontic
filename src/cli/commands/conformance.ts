import { join } from "node:path";
import type { Adapter } from "../../adapters/types.js";
import { runFacts } from "../../facts/runner.js";
import { loadModel } from "../../loader/load-model.js";
import {
  type Conformance,
  type ConformanceInputs,
  computeConformance,
  textAnchorsToResolve,
} from "../../query/conformance.js";
import { collectAnchorStrings } from "../../validate/checks.js";
import { resolveAnchorPresence } from "../../validate/presence.js";

export type ConformanceResult =
  | { ran: true; conformance: Conformance; factsSkipped?: string }
  | { ran: false; skippedReason: string };

export interface ConformanceOptions {
  /**
   * Target repo checkout root. When given, anchor/test files are resolved
   * against it (a `met` then means "verified against code", and missing files
   * become gaps). When omitted, resolution is skipped and declared anchors/tests
   * are trusted structurally — see `Conformance.repoResolved`.
   */
  repoRoot?: string | undefined;
  /**
   * Adapter used to extract queue facts, so `consumes_queues` declarations can
   * be matched against real code. Omitted ⇒ queue obligations are not checked.
   */
  adapter?: Adapter | undefined;
  /** B3 content cache dir passthrough for fact extraction (`null` disables). */
  cacheDir?: string | null | undefined;
}

/**
 * `codeontic conformance`: MODEL→CODE report card — per node, does the
 * implementation measure up (anchored + guarded), and where are the gaps.
 *
 * Advisory, like `coverage`/`reconcile`: the CLI layer never fails a job on it
 * by default (a `--strict` opt-in flips gaps into a non-zero exit for local
 * use). But "don't fail" must never become "report a number that isn't true",
 * so the same skip discipline as `runCoverage` applies:
 * - model dir missing/unreadable → `ran: false` (a skip, never "0 graded").
 * - EVERY file failed to parse → `ran: false` for the same reason.
 * - SOME files failed to parse → report, carrying the count through so the
 *   output says the numbers are a lower bound on a partial graph.
 *
 * Anchor resolution is `resolveAnchorPresence` — ONE stat, and at most one
 * read, per unique anchored file (never per anchor), answering both "does the
 * file exist" and "does it still name this symbol/text". It is the same call
 * `check` makes, which is the point: before Proposal 016 T6 this command
 * stat'd files only, so a renamed symbol left the score at `met code✓ test✓`
 * while `check` warned about it two lines earlier.
 *
 * Reading the files costs more than stat'ing them and still lands well inside
 * the deterministic tier's sub-second, zero-LLM, zero-network budget: measured
 * on a 60-node model over its real repo (208 anchors deduped to 88 files), the
 * whole resolution step is ~20ms. It scales with FILES, not anchors, which is
 * why the dedup in `resolveAnchorPresence` is load-bearing rather than tidy.
 */
export async function runConformance(
  targetDir: string,
  options: ConformanceOptions = {},
): Promise<ConformanceResult> {
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

  const inputs: ConformanceInputs = {};
  let factsSkipped: string | undefined;

  // Resolve anchor/test files once, if a repo root was supplied: existence AND
  // symbol/text presence, from the module `check` shares (validate/presence.ts).
  if (options.repoRoot !== undefined) {
    const presence = await resolveAnchorPresence(options.repoRoot, {
      anchors: collectAnchorStrings(load.graph),
      textAnchors: textAnchorsToResolve(load.graph),
    });
    inputs.existingFiles = presence.existingFiles;
    // One set, because the grader asks one question of it ("does this pointer
    // still land on something?") and the two forms differ only in their key.
    inputs.staleAnchors = new Set([...presence.staleSymbolAnchors, ...presence.staleTextAnchors]);
  }

  // Extract queue-fact names, if an adapter was supplied and the repo is a git
  // checkout. A repo that isn't a git checkout is reported (a loud skip), not
  // silently treated as "all queues missing".
  if (options.adapter && options.repoRoot !== undefined) {
    const factsResult = await runFacts(options.repoRoot, {
      ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
      adapter: options.adapter,
    });
    if (!factsResult.ran) {
      factsSkipped = factsResult.skippedReason;
    } else {
      const nameMatchable = new Set(options.adapter.nameMatchableSignalKinds ?? []);
      inputs.queueFactNames = new Set(
        factsResult.facts.filter((f) => nameMatchable.has(f.signal)).map((f) => f.name),
      );
    }
  }

  const conformance = computeConformance(load.graph, inputs, parseErrors);
  return factsSkipped ? { ran: true, conformance, factsSkipped } : { ran: true, conformance };
}
