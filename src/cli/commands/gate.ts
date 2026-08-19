import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { CODEONTIC_CONFIG_RELATIVE_PATH } from "../../config/config-file.js";
import { loadModel } from "../../loader/load-model.js";
import { materializeModelAtRef, mergeBaseOf, repoFilesAtRef } from "../../query/base-tree.js";
import { gitRootOf } from "../../query/diff.js";
import { inv1ViolationsFrom } from "../../validate/inv1/check.js";
import { loadInv1Config } from "../../validate/inv1/config.js";
import { runT0 } from "../../validate/t0.js";
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
function violationKey(v: Violation): string {
  // NUL as the separator, written as an ESCAPE — a literal NUL byte in a source
  // file makes git treat the whole file as binary, and its diff silently
  // disappears from every review and every `git diff` from then on.
  return [v.check, v.nodeId ?? "", v.file ?? "", v.message].join("\u0000");
}

/**
 * What the gate judges: everything `check` judges. A repo that moves its CI
 * from `check` to `gate` must not quietly lose a check — that is a downgrade
 * disguised as an upgrade, and nothing in the output would say so.
 *
 * The two error sources have different ATTRIBUTION mechanics, handled below by
 * `DIFF_ATTRIBUTED` rather than by dropping anything here:
 *  - T0 and the config parse are scored on both sides (base from git plumbing),
 *    so "already broken at base" is answerable and pre-existing debt does not
 *    block unrelated work;
 *  - baseline-growth and INV-1 are computed against the base ref by `check`
 *    itself, so they are about this change by construction.
 *
 * `inv1ConfigError` counts as an error of its own. A malformed
 * `.codeontic/config.json` means the INV-1 layer never ran, and a gate that
 * scored that as "no errors" would go green precisely because a check broke.
 */
function errorsOf(check: CheckResult): Violation[] {
  const all: Violation[] = [
    ...check.t0.violations,
    ...(check.baselineViolations ?? []),
    ...(check.inv1 ? inv1ViolationsFrom(check.inv1) : []),
  ];
  if (check.inv1ConfigError) all.push(configViolation(check.inv1ConfigError));
  return all.filter((v) => v.severity === "error");
}

/**
 * Findings that are ALREADY about this change, so comparing them against the
 * base would be wrong twice over — the base cannot produce them, and they would
 * therefore always read as new anyway.
 *
 * Both kinds here are computed relative to the base ref by `check` itself:
 *  - `baseline-growth` IS the comparison ("the debt list shrank since base");
 *  - `inv1-write-site`, once `diffBase` is set, scans ONLY the files this change
 *    touched (`onlyFiles`), so a violation it reports is in a file this change
 *    edited. This is what makes INV-1 gate-able without checking the base out —
 *    the previous release excluded it wholesale, which meant a repo that moved
 *    its CI from `check` to `gate` silently lost INV-1 enforcement.
 */
const DIFF_ATTRIBUTED = new Set<string>(["baseline-growth", "inv1-write-site"]);

/**
 * A broken `.codeontic/config.json` as a comparable finding. Its own check name
 * (not `inv1-write-site`) matters twice: the base side can produce the identical
 * key — config is PARSED, and parsing needs only `git show`, unlike the AST scan
 * INV-1 performs — so a trunk-side breakage compares equal and reads as
 * pre-existing instead of being blamed on whoever opened the next PR; and the
 * guidance can name the config file rather than telling the author to "fix the
 * model", which is not where the problem is.
 */
export const CONFIG_CHECK = "codeontic-config";

function configViolation(error: string): Violation {
  return {
    check: CONFIG_CHECK,
    severity: "error",
    message: `INV-1 could not run: ${error}`,
  };
}

/**
 * Score the model as it stood at `base`, without checking that ref out: the
 * model's YAML comes from `git show`, anchor existence from `git ls-tree`.
 * Returns undefined when anything about the base is unusable — the caller must
 * fail closed rather than treat "could not score the base" as "the base was
 * clean" or "the base was equally broken".
 */
async function errorsAtBase(
  targetDir: string,
  options_repoRoot: string,
  base: string,
  strict: boolean | undefined,
): Promise<{ errors: Violation[] } | { reason: string }> {
  const gitRoot = await gitRootOf(options_repoRoot);
  if (!gitRoot) return { reason: `${options_repoRoot} is not inside a git checkout` };

  const mergeBase = await mergeBaseOf(gitRoot, base);
  if (!mergeBase) return { reason: `no merge-base between "${base}" and HEAD (unfetched ref?)` };

  // Anchors resolve against repoRoot, so the base set must speak the same
  // coordinates — otherwise every anchor reads as absent at base, and a file
  // this change really deleted produces the same message on both sides.
  const repoRootReal = await realpath(options_repoRoot).catch(() => resolve(options_repoRoot));
  const gitRootRealForFiles = await realpath(gitRoot).catch(() => gitRoot);
  const repoPrefix = relative(gitRootRealForFiles, repoRootReal).split(/[/\\]/).join("/");
  const files = await repoFilesAtRef(gitRoot, mergeBase, repoPrefix || undefined);
  if (!files) return { reason: `could not list the tree at ${mergeBase.slice(0, 12)}` };

  // The model dir is expressed relative to the git root, since that is what git
  // pathspecs take — `targetDir` may sit deeper than the checkout root.
  // Both sides are realpath'd first: git reports the resolved root, while the
  // caller's path may run through a symlink (on macOS every $TMPDIR does), and
  // a raw prefix-slice of two differently-spelled absolute paths silently
  // produces a pathspec that matches nothing — which would read as "no model at
  // base" and fail the gate closed for a reason that isn't true.
  const modelAbs = await realpath(join(targetDir, ".codeontic", "model")).catch(() =>
    resolve(targetDir, ".codeontic", "model"),
  );
  const gitRootReal = await realpath(gitRoot).catch(() => gitRoot);
  const modelRelDir = relative(gitRootReal, modelAbs).split(/[/\\]/).join("/");
  const targetRel = relative(gitRootReal, await realpath(targetDir).catch(() => resolve(targetDir)))
    .split(/[/\\]/)
    .join("/");
  const configRel = [targetRel, CODEONTIC_CONFIG_RELATIVE_PATH.split(sep).join("/")]
    .filter(Boolean)
    .join("/");
  const materialized = await materializeModelAtRef(gitRoot, modelRelDir, mergeBase, [configRel]);
  if (!materialized) {
    return { reason: `no model under "${modelRelDir}" at ${mergeBase.slice(0, 12)}` };
  }

  try {
    const load = await loadModel(materialized.modelDir);
    const t0 = await runT0(load, {
      repoRoot: options_repoRoot,
      strictAnchorExistence: strict,
      repoFileSet: files,
    });
    const errors = t0.violations.filter((v) => v.severity === "error");
    // Same parse the HEAD side runs, against the base's own config bytes.
    const baseConfig = await loadInv1Config(materialized.targetDir);
    if (baseConfig.error) errors.push(configViolation(baseConfig.error));
    return { errors };
  } finally {
    await materialized.cleanup();
  }
}

export async function runGate(targetDir: string, options: GateOptions = {}): Promise<GateResult> {
  const check = await runCheck(targetDir, {
    repoRoot: options.repoRoot,
    strictAnchorExistence: options.strictAnchorExistence,
    // Passing the base through is what makes two whole checks work at all:
    // `baseline-growth` is computed only when there is a base to grow from, and
    // INV-1 narrows its AST scan to the touched files. Omitting it — the 0.13.0
    // shape — left `baselineViolations` permanently undefined (so `gate --base`
    // never ran a check that `check --diff` fails on) and made INV-1 scan the
    // whole repo for a result the gate then threw away.
    ...(options.base ? { diffBase: options.base } : {}),
  });
  const errors = errorsOf(check);

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
      baseUnavailableReason:
        "--base needs --repo-root: without it the anchor and INV-1 layers do not run at all, " +
        "so an empty result would mean 'not checked', not 'clean'",
    };
  }
  if (errors.length === 0) {
    return { verdict: "clean", exitCode: 0, check, errors, newErrors: [] };
  }
  if (!options.base) {
    return { verdict: "new-errors", exitCode: 1, check, errors, newErrors: errors };
  }

  const base = await errorsAtBase(
    targetDir,
    options.repoRoot as string,
    options.base,
    options.strictAnchorExistence,
  );
  if ("reason" in base) {
    return {
      verdict: "unverifiable-base",
      exitCode: 1,
      check,
      errors,
      newErrors: errors,
      baseUnavailableReason: base.reason,
    };
  }

  // Split before comparing, rather than relying on the base side happening not
  // to produce these keys: that would be an invisible coupling, and the day the
  // base side learns to score one of them it would start cancelling findings
  // that are by definition about this change.
  const baseKeys = new Set(base.errors.map(violationKey));
  const newErrors = errors.filter(
    (v) => DIFF_ATTRIBUTED.has(v.check) || !baseKeys.has(violationKey(v)),
  );
  return newErrors.length > 0
    ? { verdict: "new-errors", exitCode: 1, check, errors, newErrors }
    : { verdict: "preexisting", exitCode: 0, check, errors, newErrors: [] };
}
