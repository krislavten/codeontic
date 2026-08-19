import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadModel } from "../../loader/load-model.js";
import {
  type AffectedNode,
  affectedNodes,
  changedFiles,
  debtIdsAtRef,
  gitRootOf,
} from "../../query/diff.js";
import { checkBaselineOnlyDecreases } from "../../validate/baseline.js";
import { type Inv1CheckResult, runInv1Check } from "../../validate/inv1/check.js";
import { loadInv1Config } from "../../validate/inv1/config.js";
import { runT0 } from "../../validate/t0.js";
import type { T0Result, Violation } from "../../validate/types.js";

export interface CheckOptions {
  repoRoot?: string | undefined;
  strictAnchorExistence?: boolean | undefined;
  /** `--diff <base-ref>`: incremental mode (B2) — scan only the diff closure + map affected nodes. */
  diffBase?: string | undefined;
}

export interface DiffInfo {
  baseRef: string;
  /** repo-relative files changed in repoRoot's diff (undefined = couldn't resolve → full scan fallback). */
  changed?: string[];
  /** model nodes whose anchors point at a changed file. */
  affected: AffectedNode[];
  /** true when INV-1 ran incrementally (only changed candidate files). */
  incremental: boolean;
}

export interface CheckResult {
  t0: T0Result;
  /** Present only when a repoRoot is given AND a valid .codeontic/config.json is found. */
  inv1?: Inv1CheckResult;
  /** Set when a config file exists but is malformed — a loud error, not a silent skip. */
  inv1ConfigError?: string;
  /** Present only with `--diff`. */
  diff?: DiffInfo;
  /** baseline-growth violations from `--diff` (new debt ids vs the base ref). */
  baselineViolations?: Violation[];
}

/**
 * Runs T0 (model + optional anchor existence), the INV-1 canonical-writer scan
 * (when a repoRoot + config are present), and — with `--diff <base>` — the
 * incremental B2 path: resolve the diff, scan INV-1 over only the changed files,
 * map changed files to affected model nodes, and enforce baseline-only-decreases
 * against the model at the base ref.
 */
/**
 * Re-expresses git's top-level-relative paths against `repoRoot`, dropping the
 * ones that fall outside it (another service's files, in a monorepo where the
 * scan is scoped to one package). Returns them unchanged when repoRoot IS the
 * checkout root, which is the common case.
 */
async function toRepoRootRelative(paths: string[], repoRoot: string): Promise<string[]> {
  const gitRoot = await gitRootOf(repoRoot);
  if (!gitRoot) return paths;
  const gitRootReal = await realpath(gitRoot).catch(() => gitRoot);
  const repoRootReal = await realpath(repoRoot).catch(() => repoRoot);
  const prefix = relative(gitRootReal, repoRootReal).split(/[/\\]/).join("/");
  if (!prefix || prefix.startsWith("..")) return paths;
  const head = `${prefix}/`;
  return paths.filter((p) => p.startsWith(head)).map((p) => p.slice(head.length));
}

export async function runCheck(
  targetDir: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const modelDir = join(targetDir, ".codeontic", "model");
  const load = await loadModel(modelDir);
  const t0 = await runT0(load, options);

  // --- baseline-only-decreases (B2): model debt at base ref vs now ---
  let baselineViolations: Violation[] | undefined;
  if (options.diffBase) {
    const modelGitRoot = await gitRootOf(targetDir);
    if (modelGitRoot) {
      // Both sides resolved before subtracting: git reports the REAL root while
      // the caller's path may run through a symlink (on macOS every $TMPDIR
      // does, and CI checkouts under /var hit the same thing). Subtracting the
      // two spellings raw yields a `../../..`-shaped pathspec that matches
      // nothing, `debtIdsAtRef` returns undefined, and the whole baseline check
      // is skipped — silently, since "no prior baseline" is a legitimate state.
      const gitRootReal = await realpath(modelGitRoot).catch(() => modelGitRoot);
      const modelDirReal = await realpath(modelDir).catch(() => modelDir);
      const before = await debtIdsAtRef(
        modelGitRoot,
        relative(gitRootReal, modelDirReal),
        options.diffBase,
      );
      if (before) {
        const after = new Set(load.graph.byKind.debt.keys());
        baselineViolations = checkBaselineOnlyDecreases(before, after);
      }
    }
  }

  if (!options.repoRoot) return { t0, ...(baselineViolations ? { baselineViolations } : {}) };

  // --- diff resolution over the scanned repo (B2) ---
  let diff: DiffInfo | undefined;
  let onlyFiles: Set<string> | undefined;
  if (options.diffBase) {
    const raw = await changedFiles(options.repoRoot, options.diffBase);
    // `git diff --name-only` speaks GIT-TOP-LEVEL paths no matter which
    // directory it ran in, while everything downstream — INV-1's `git grep`
    // candidates, and the model's anchors — speaks REPO-ROOT paths. When
    // `--repo-root` is the checkout root the two coincide, which is why this
    // went unnoticed; point it at a subdirectory and the intersection is empty:
    // INV-1 scans zero files and reports a clean result, and `affected` maps no
    // node to any changed file.
    const changed = raw ? await toRepoRootRelative(raw, options.repoRoot) : undefined;
    onlyFiles = changed ? new Set(changed) : undefined;
    diff = {
      baseRef: options.diffBase,
      ...(changed ? { changed } : {}),
      affected: changed ? affectedNodes(load.graph, changed) : [],
      incremental: onlyFiles !== undefined,
    };
  }

  const configResult = await loadInv1Config(targetDir);
  if (configResult.error) {
    return {
      t0,
      inv1ConfigError: configResult.error,
      ...(diff ? { diff } : {}),
      ...(baselineViolations ? { baselineViolations } : {}),
    };
  }
  if (!configResult.config) {
    return {
      t0,
      ...(diff ? { diff } : {}),
      ...(baselineViolations ? { baselineViolations } : {}),
    };
  }

  const inv1 = await runInv1Check(
    options.repoRoot,
    configResult.config,
    onlyFiles ? { onlyFiles } : {},
  );
  return {
    t0,
    inv1,
    ...(diff ? { diff } : {}),
    ...(baselineViolations ? { baselineViolations } : {}),
  };
}
