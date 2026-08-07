import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { componentLabel, componentOf, loadComponents } from "../../config/components.js";
import { loadModel } from "../../loader/load-model.js";
import {
  type BacktestCommit,
  type BacktestPartitioning,
  type BacktestReport,
  type CoverageRatioStats,
  type ModelRef,
  computeBacktest,
  computeCoverageRatio,
} from "../../query/backtest.js";
import { gitRootOf } from "../../query/diff.js";
import { readGitInfo } from "../../staleness.js";

const execFileAsync = promisify(execFile);

/** Post-filter window size (Proposal issue #23 判据 A): how many `.ts`/`.tsx`-touching
 * commits to collect. Matches the issue's original repro script's N=50. */
export const DEFAULT_BACKTEST_WINDOW = 50;

/**
 * Upper bound on RAW commits walked while collecting the window. Without a
 * cap, a repo whose recent history is mostly non-TS (docs/infra churn) could
 * make this walk arbitrarily far back looking for a window that never fills.
 * `formatBacktest`'s "scanCapped" line is how a reader is told the shortfall
 * is a cap artifact rather than "this repo really only has 12 TS commits ever".
 */
export const BACKTEST_SCAN_CAP = 500;

const TS_EXTENSION = /\.tsx?$/;

/** Byte that can never appear in a `git log --format` %H hash or a file path
 * (paths from git are UTF-8 text; \x01 is a control character), so splitting
 * on it can never misfire on content that happens to collide with it. */
const COMMIT_SENTINEL = "\x01";

interface RawLogCommit {
  sha: string;
  files: string[];
}

/**
 * Parses `git log --format=<SENTINEL>%H --name-only` output into per-commit
 * file lists. Pure (string in, structure out) so the parsing itself is
 * unit-testable without a git subprocess. Each chunk after splitting on the
 * sentinel is `<sha>\n\n<file>\n<file>\n...` (git emits a blank separator
 * line between the hash and the file list, and again before the next
 * commit's sentinel) — blank lines are simply filtered out of the file list,
 * so that layout detail doesn't need to be asserted on.
 */
export function parseLogOutput(stdout: string): RawLogCommit[] {
  return stdout
    .split(COMMIT_SENTINEL)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const sha = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      const rest = nl === -1 ? "" : chunk.slice(nl + 1);
      const files = rest
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return { sha, files };
    });
}

export interface CollectedCommits {
  /** qualifying commits only (>=1 `.ts`/`.tsx` file changed), most-recent-first, length <= windowRequested. */
  commits: BacktestCommit[];
  /** raw commits walked (>= commits.length) to collect them. */
  commitsScanned: number;
  scanCapped: boolean;
}

/**
 * Walks `ref`'s history (`--no-merges`) collecting up to `windowRequested`
 * commits that changed >=1 `.ts`/`.tsx` file. This "changed a .ts/.tsx file"
 * test IS the doc/chore-commit filter — issue #23's repro script achieves
 * "skip non-code commits" exactly this way (grep -E "\.tsx?$" on the changed
 * file list), not via a second commit-message-based filter layered on top.
 * Stacking a message-based filter here would change the measured percentage
 * away from the already-verified 36%/18-of-50 baseline for no stated reason.
 *
 * A SINGLE `git log --name-only` call fetches everything, not one `git show`
 * per commit (which would be O(window) subprocesses on a 500-commit walk).
 *
 * Returns undefined when the ref/repo can't be resolved at all (bad ref /
 * not a git checkout), so the caller can report a clean skip rather than an
 * exception.
 */
export async function collectBacktestCommits(
  gitRoot: string,
  ref: string,
  windowRequested: number,
  scanCap = BACKTEST_SCAN_CAP,
): Promise<CollectedCommits | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        "log",
        "--no-merges",
        `--format=${COMMIT_SENTINEL}%H`,
        "--name-only",
        "-n",
        String(scanCap),
        ref,
      ],
      { cwd: gitRoot, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return undefined; // bad ref / not a git repo
  }

  const raw = parseLogOutput(stdout);
  const commits: BacktestCommit[] = [];
  let scanned = 0;
  for (const c of raw) {
    scanned++;
    const tsFiles = c.files.filter((f) => TS_EXTENSION.test(f));
    if (tsFiles.length > 0) {
      commits.push({ sha: c.sha, tsFiles });
      if (commits.length >= windowRequested) break;
    }
  }

  // `raw.length === scanCap` means git had at least that many commits to
  // give us and we can't tell (without another call) whether more history
  // exists beyond the cap — reported as capped rather than silently assumed
  // to be the true total. `raw.length < scanCap` means git ran out of
  // history on its own (reached the root commit), which is a genuine
  // "the repo doesn't have more" fact, not a cap artifact.
  const scanCapped = commits.length < windowRequested && raw.length === scanCap;
  return { commits, commitsScanned: scanned, scanCapped };
}

export interface BacktestOptions {
  /** git repo to scan. Defaults to `targetDir` (self-hosted: model dir IS the repo root). */
  repoRoot?: string | undefined;
  /** git ref to walk history from. Defaults to "HEAD". */
  ref?: string | undefined;
  /** post-filter window size. Defaults to DEFAULT_BACKTEST_WINDOW (50). */
  window?: number | undefined;
}

export type BacktestResult =
  | { ran: true; report: BacktestReport; coverageRatio: CoverageRatioStats; modelRef: ModelRef }
  | {
      ran: false;
      skippedReason: string;
      coverageRatio?: CoverageRatioStats;
      modelRef?: ModelRef;
    };

/**
 * `codeontic backtest`: 判据 A end to end — load the model, resolve the repo,
 * walk history for the window, and compute the hit rate. Advisory/read-only
 * (like `coverage`/`graph`/`overview`): never throws on a resolvable failure,
 * always returns a reportable `ran: false` instead.
 *
 * `coverageRatio` (判据 C) and `modelRef` are attached whenever the model
 * itself loaded — even on a `ran: false` result caused by a LATER failure
 * (bad ref, not a git checkout, broken components config). Both need only
 * the model (graph / working-tree git state), no commit-window scan at all,
 * so a git-log failure must not also hide them: a nightly consumer watching
 * all three would otherwise lose C and the model stamp on exactly the nights
 * A's git scan has trouble, which is backwards. They are absent only when
 * the model itself failed to load/parse (the two `return`s before
 * component/git resolution below).
 */
export async function runBacktest(
  targetDir: string,
  options: BacktestOptions = {},
): Promise<BacktestResult> {
  const window = options.window ?? DEFAULT_BACKTEST_WINDOW;
  const ref = options.ref ?? "HEAD";
  const repoRootInput = options.repoRoot ?? targetDir;

  let load: Awaited<ReturnType<typeof loadModel>>;
  try {
    load = await loadModel(join(targetDir, ".codeontic", "model"));
  } catch (err) {
    return { ran: false, skippedReason: err instanceof Error ? err.message : String(err) };
  }
  if (load.parseErrors.length > 0 && load.entries.length === 0) {
    return {
      ran: false,
      skippedReason: `all ${load.parseErrors.length} model file(s) failed to parse — run "codeontic check" for the errors`,
    };
  }

  // The model parsed — C and the model stamp are computable from here on,
  // regardless of what happens with components/git below. `modelRef` is
  // stamped off `targetDir` itself (where the model was actually read from),
  // not `repoRootInput` — those are usually the same path but need not be.
  const coverageRatio = computeCoverageRatio(load.graph);
  const modelGitInfo = await readGitInfo(targetDir);
  const modelRef: ModelRef = { head: modelGitInfo.head, dirty: modelGitInfo.dirty };

  // Component partitioning (opt-in, src/config/components.ts): a MALFORMED
  // `.codeontic/config.json` `components` section is a loud failure here, the
  // same as it is for `codeontic init`/INV-1 — it means the author tried to
  // declare a partition and got it wrong, which must not silently degrade to
  // "no components" (that would just report a clean overall-only number and
  // hide the mistake). An ABSENT section, by contrast, really is "not opted
  // in" and degrades to overall-only.
  const componentsResult = await loadComponents(targetDir);
  if (componentsResult.error) {
    return { ran: false, skippedReason: componentsResult.error, coverageRatio, modelRef };
  }
  const declaredComponents = componentsResult.components;
  const partitioning: BacktestPartitioning | undefined = declaredComponents
    ? {
        declared: declaredComponents.map((c) => ({
          id: c.id,
          label: componentLabel(c),
          role: c.role,
        })),
        resolve: (file) => {
          const c = componentOf(declaredComponents, file);
          return c ? { id: c.id, label: componentLabel(c), role: c.role } : undefined;
        },
      }
    : undefined;

  const gitRoot = await gitRootOf(repoRootInput);
  if (!gitRoot) {
    return {
      ran: false,
      skippedReason: `--repo-root "${repoRootInput}" is not inside a git checkout`,
      coverageRatio,
      modelRef,
    };
  }

  const collected = await collectBacktestCommits(gitRoot, ref, window);
  if (!collected) {
    // `git log <ref>` fails identically for a genuinely bad ref AND for a
    // freshly-`git init`'d repo with zero commits (HEAD is unborn) — both
    // are just "nothing resolvable", so the message covers both rather than
    // asserting the ref is wrong when the repo might simply be empty.
    return {
      ran: false,
      skippedReason: `could not resolve ref "${ref}" in ${gitRoot} (bad ref, or the repo has no commits yet)`,
      coverageRatio,
      modelRef,
    };
  }

  const computation = computeBacktest(load.graph, collected.commits, partitioning);

  return {
    ran: true,
    report: {
      ...computation,
      ref,
      windowRequested: window,
      commitsScanned: collected.commitsScanned,
      scanCapped: collected.scanCapped,
      componentsDeclared: partitioning !== undefined,
    },
    coverageRatio,
    modelRef,
  };
}
