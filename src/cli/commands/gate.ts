import { mergeBaseOf, pathInBaseWorktree, withBaseWorktree } from "../../query/base-worktree.js";
import { gitRootOf } from "../../query/diff.js";
import { checkBaselineOnlyDecreases } from "../../validate/baseline.js";
import { inv1ViolationsFrom } from "../../validate/inv1/check.js";
import type { Violation } from "../../validate/types.js";
import { type CheckResult, runCheck } from "./check.js";

/**
 * `codeontic gate` — the CI entry point: run the deterministic checks, decide
 * an exit code, and explain the verdict.
 *
 * WHY THIS IS A COMMAND AND NOT A RECIPE. Everything here was, in the first
 * repo that promoted this tier, ~70 lines of hand-written workflow shell. Every
 * bug found in that promotion lived in those lines, and none of them were about
 * the target repo:
 *   - the base comparison died before it ran, because a bare redirect under
 *     `bash -e` (GitHub's default shell) aborts the step;
 *   - an empty error set compared against anything is empty, so a pipeline
 *     failure that produced no findings was scored "already broken at base" and
 *     the gate went GREEN while claiming errors pre-existed;
 *   - the comparison key was scraped from human-readable output with a regex
 *     that stopped at the node id, so a newly broken anchor on a node that
 *     already had one collapsed into the old entry and was waved through.
 * Each of those is structurally impossible here: the comparison runs on typed
 * `Violation`s, "no errors" and "could not run" are different values rather
 * than the same empty string, and the exit code is a return value.
 */

export type GateVerdict =
  /** No errors at HEAD. */
  | "clean"
  /** Errors at HEAD that are NOT present at the base ref — this change introduced them. */
  | "new-errors"
  /** Errors at HEAD, all of which already exist at the base ref. */
  | "preexisting"
  /** Errors at HEAD and no usable base to compare against — fails closed. */
  | "unverifiable-base";

export interface GateOptions {
  repoRoot?: string | undefined;
  strictAnchorExistence?: boolean | undefined;
  /**
   * Compare against this ref and only fail on errors this change introduced.
   * Omitted → every error fails (the plain, no-baseline gate).
   */
  base?: string | undefined;
}

export interface GateResult {
  verdict: GateVerdict;
  /** Exit code the CLI should use: non-zero for new-errors / unverifiable-base. */
  exitCode: 0 | 1;
  check: CheckResult;
  /** Error-severity violations at HEAD (empty when clean). */
  errors: Violation[];
  /** Subset of `errors` absent at the base ref. Empty unless verdict is "new-errors". */
  newErrors: Violation[];
  /** Why the base could not be scored, when verdict is "unverifiable-base". */
  baseUnavailableReason?: string;
  /**
   * `"model-only"` when no repoRoot was given: anchor existence and INV-1 did
   * not run. Carried on the result so every renderer has to face it — a verdict
   * that omits WHAT WAS CHECKED reads as a full pass in the one place people
   * look, the summary.
   */
  scope: "full" | "model-only";
}

/**
 * Identity of a finding across two trees. The MESSAGE is part of the key on
 * purpose: it carries the anchor, the colliding id, the dangling reference —
 * the part that says WHICH thing broke. Keying on `check + nodeId` alone lets a
 * second breakage on an already-broken node hide behind the first.
 *
 * The trade-off is deliberate: if the engine rewords a message, every finding
 * reads as new for one release. That direction is safe (the gate fires when it
 * should not, and someone looks); the other direction is a silent pass.
 */
function violationKey(v: Violation, roots: readonly string[] = []): string {
  // NUL as the separator, written as an ESCAPE — a literal NUL byte in a source
  // file makes git treat the whole file as binary, and its diff silently
  // disappears from every review and every `git diff` from then on.
  return [v.check, v.nodeId ?? "", v.file ?? "", redactRoots(v.identity ?? v.message, roots)].join(
    "\u0000",
  );
}

/**
 * Replaces absolute checkout paths in a message with a placeholder.
 *
 * Messages are part of the comparison key (that is what catches a SECOND
 * breakage on an already-broken node), and several of them quote the root they
 * were scored against — "…does not exist under /path/to/repo". The base side
 * now runs in a temp worktree, so that path differs on the two sides by
 * construction: without this, EVERY pre-existing finding reads as new and the
 * gate blocks every PR in the repo. Longest-first so a nested root (repoRoot
 * inside the worktree) is replaced before its parent.
 */
function redactRoots(message: string, roots: readonly string[]): string {
  let out = message;
  for (const root of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(root).join("<root>");
  }
  return out;
}

/**
 * What the gate judges: everything `check` judges. A repo that moves its CI
 * from `check` to `gate` must not quietly lose a check — that is a downgrade
 * disguised as an upgrade, and nothing in the output would say so.
 *
 * There is no per-check attribution logic here, and that is the point: the base
 * side runs THIS SAME FUNCTION over a checkout of the base ref, so a finding is
 * "new" iff it is absent from the other side's set. Every earlier attempt to
 * decide attribution check-by-check (drop INV-1; attribute it by touched files;
 * score anchors from a git tree while HEAD used `stat`) produced a different
 * wrong answer per check — see base-worktree.ts.
 *
 * `inv1ConfigError` counts as an error of its own. A malformed
 * `.codeontic/config.json` means the INV-1 layer never ran, and a gate that
 * scored that as "no errors" would go green precisely because a check broke.
 */
function errorsOf(check: CheckResult): Violation[] {
  const all: Violation[] = [
    ...check.t0.violations,
    ...(check.inv1 ? inv1ViolationsFrom(check.inv1) : []),
  ];
  if (check.inv1ConfigError) all.push(configViolation(check.inv1ConfigError));
  return all.filter((v) => v.severity === "error");
}

/**
 * A broken `.codeontic/config.json` as a comparable finding, under its own check
 * name rather than INV-1's: "INV-1 found a bad write site" and "INV-1 could not
 * start" call for opposite actions, and the guidance below keys off the name to
 * point at the config file instead of telling the author to fix the model.
 */
export const CONFIG_CHECK = "codeontic-config";

function configViolation(error: string): Violation {
  return {
    check: CONFIG_CHECK,
    severity: "error",
    message: `INV-1 could not run: ${error}`,
  };
}

/** Everything the base side yields: the same errors, plus the debt ids to diff. */
interface BaseScore {
  errors: Violation[];
  debtIds: ReadonlySet<string>;
  /** The base-side absolute paths, so the comparison can redact them out. */
  roots: string[];
}

/**
 * Score the base ref by CHECKING IT OUT and running the identical check.
 *
 * Returns a reason instead of a score whenever anything is off. Failing closed
 * matters more here than anywhere else in the command: "could not score the
 * base" silently treated as "the base was equally broken" is how a gate passes
 * a change that broke something.
 */
async function scoreBase(
  targetDir: string,
  repoRoot: string,
  base: string,
  strict: boolean | undefined,
): Promise<BaseScore | { reason: string }> {
  const gitRoot = await gitRootOf(repoRoot);
  if (!gitRoot) return { reason: `${repoRoot} is not inside a git checkout` };

  const mergeBase = await mergeBaseOf(gitRoot, base);
  if (!mergeBase) return { reason: `no merge-base between "${base}" and HEAD (unfetched ref?)` };

  const scored = await withBaseWorktree(gitRoot, mergeBase, async (baseDir) => {
    // Anything the base check throws becomes a REASON, never an exception:
    // a base ref from before the model existed (or from before it was renamed)
    // makes `loadModel` throw, and letting that escape turns the gate into a
    // crash whose message — "run codeontic init" — describes the base tree
    // while appearing to describe the user's checkout.
    try {
      // The two paths are mapped INDIVIDUALLY: `--repo-root` may be a
      // subdirectory of the checkout, or the model may live outside the scanned
      // package. Assuming either equals the worktree root scans a different
      // scope than HEAD did, and every finding on both sides becomes noise.
      const baseTarget = await pathInBaseWorktree(gitRoot, targetDir, baseDir);
      const baseRepoRoot = await pathInBaseWorktree(gitRoot, repoRoot, baseDir);
      const check = await runCheck(baseTarget, {
        repoRoot: baseRepoRoot,
        strictAnchorExistence: strict,
      });
      return { errors: errorsOf(check), debtIds: check.debtIds, roots: [baseTarget, baseRepoRoot] };
    } catch (err) {
      return {
        reason: `scoring ${mergeBase.slice(0, 12)} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
  if (!scored) return { reason: `could not check out ${mergeBase.slice(0, 12)}` };
  return scored;
}

export async function runGate(targetDir: string, options: GateOptions = {}): Promise<GateResult> {
  // No `diffBase`: the base side runs the identical call over a checkout, so
  // both sides must see the SAME scope. Handing HEAD a diff base would narrow
  // INV-1 to the touched files on one side and scan everything on the other,
  // and the set difference would then report every untouched pre-existing
  // violation as removed and every touched one as new.
  const check = await runCheck(targetDir, {
    repoRoot: options.repoRoot,
    strictAnchorExistence: options.strictAnchorExistence,
  });
  const errors = errorsOf(check);
  const scope = options.repoRoot ? ("full" as const) : ("model-only" as const);

  // BEFORE the clean short-circuit, deliberately. `--base` without `--repo-root`
  // is a misconfigured pipeline, and the damage it does is not "one error gets
  // mis-blamed" — without a repoRoot the anchor-existence and INV-1 layers never
  // run at all, so the usual outcome is an EMPTY error set. Judged after the
  // short-circuit, that reads as `clean` / exit 0: a green gate produced by a
  // gate that did not run. Fail here and the pipeline gets fixed.
  if (options.base && !options.repoRoot) {
    return {
      verdict: "unverifiable-base",
      exitCode: 1,
      check,
      errors,
      newErrors: errors,
      scope,
      baseUnavailableReason:
        "--base needs --repo-root: without it the anchor and INV-1 layers do not run at all, " +
        "so an empty result would mean 'not checked', not 'clean'",
    };
  }
  if (!options.base) {
    return errors.length === 0
      ? { verdict: "clean", exitCode: 0, check, errors, newErrors: [], scope }
      : { verdict: "new-errors", exitCode: 1, check, errors, newErrors: errors, scope };
  }

  // The base side runs even when HEAD is clean, because one finding is not
  // visible in HEAD's error set at all: debt that GREW. That is a comparison
  // between two debt id sets, and a repo whose only fault is a newly registered
  // debt node has an empty HEAD error set.
  const base = await scoreBase(
    targetDir,
    options.repoRoot as string,
    options.base,
    options.strictAnchorExistence,
  );
  if ("reason" in base) {
    // A clean HEAD with an unscorable base is not a failure: there is nothing
    // to attribute, so there is nothing the missing baseline could change. It
    // is still SAID, because one thing genuinely was not checked — debt growth
    // is a property of the pair, and without a base there is no pair.
    if (errors.length === 0) {
      return {
        verdict: "clean",
        exitCode: 0,
        check,
        errors,
        newErrors: [],
        scope,
        baseUnavailableReason: base.reason,
      };
    }
    return {
      verdict: "unverifiable-base",
      exitCode: 1,
      check,
      errors,
      newErrors: errors,
      scope,
      baseUnavailableReason: base.reason,
    };
  }

  // Each side's own roots are redacted from its own messages, so the two keys
  // meet on the same text.
  const headRoots = [targetDir, options.repoRoot as string];
  const baseKeys = new Set(base.errors.map((v) => violationKey(v, base.roots)));
  const newErrors = errors.filter((v) => !baseKeys.has(violationKey(v, headRoots)));
  // Debt growth is a property of the PAIR, not of either side — it exists only
  // once both debt id sets are in hand, so it is computed here and is new by
  // construction.
  newErrors.push(...checkBaselineOnlyDecreases(base.debtIds, check.debtIds));

  const allErrors = [...errors, ...newErrors.filter((v) => !errors.includes(v))];
  if (newErrors.length > 0) {
    return { verdict: "new-errors", exitCode: 1, check, errors: allErrors, newErrors, scope };
  }
  return errors.length === 0
    ? { verdict: "clean", exitCode: 0, check, errors, newErrors: [], scope }
    : { verdict: "preexisting", exitCode: 0, check, errors, newErrors: [], scope };
}
