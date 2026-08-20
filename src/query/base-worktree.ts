import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Checking out the base ref, so that "was it already broken?" is answered by
 * running the SAME code over the SAME shapes on both sides.
 *
 * The alternative — reading the base out of git plumbing without a checkout —
 * was tried first and cost three review rounds. Each check needed its own
 * private answer to "how would I score this at base", and each answer was a
 * near-miss:
 *   - the model's YAML could be `git show`n, but anchor EXISTENCE then came
 *     from `git ls-tree` while the HEAD side used `stat` — so an ignored or
 *     `./`-prefixed path produced the same violation text on both sides, and a
 *     real regression scored as pre-existing;
 *   - INV-1 is an AST scan, unavailable without files, so it was first dropped
 *     from the gate entirely (a repo moving from `check` to `gate` silently
 *     lost it) and then attributed by "was the file touched?", which blames a
 *     one-line import edit for a violation that had been sitting there;
 *   - every new check would have needed a fourth such answer.
 *
 * With a worktree there is one answer for all of them: run the check, diff the
 * findings. The cost that argued against it is not real — on a 4.4k-file repo
 * the checkout is ~0.5s and the second scan ~0.5s.
 */

interface BaseCheckout {
  /** Worktree root: the base ref's tree, detached. */
  dir: string;
  /** Removes the worktree and its temp parent. Safe to call once. */
  cleanup: () => Promise<void>;
}

/**
 * `merge-base(ref, HEAD)` — the point the branch diverged, which is what "was
 * it already broken" means. Comparing against the ref's tip instead would
 * report unrelated trunk changes as this branch's doing.
 */
export async function mergeBaseOf(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", ref, "HEAD"], { cwd: gitRoot });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds a detached worktree at `sha`. Returns undefined when git refuses (an
 * unfetched ref in a shallow CI clone is the common case) — callers must fail
 * closed rather than read that as "the base was clean".
 */
async function addBaseWorktree(gitRoot: string, sha: string): Promise<BaseCheckout | undefined> {
  const parent = await mkdtemp(join(tmpdir(), "codeontic-base-"));
  const dir = join(parent, "base");
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", dir, sha], { cwd: gitRoot });
  } catch {
    await rm(parent, { recursive: true, force: true });
    return undefined;
  }
  return {
    dir,
    cleanup: async () => {
      // Both halves: git forgets the worktree, the filesystem loses the copy.
      // Cleaning up only on the success path leaves entries that collide with
      // the next run's `worktree add` at the same path.
      await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: gitRoot }).catch(
        () => undefined,
      );
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** Runs `fn` against a base checkout, removing it whatever happens. */
export async function withBaseWorktree<T>(
  gitRoot: string,
  sha: string,
  fn: (dir: string) => Promise<T>,
): Promise<T | undefined> {
  const checkout = await addBaseWorktree(gitRoot, sha);
  if (!checkout) return undefined;
  try {
    return await fn(checkout.dir);
  } finally {
    await checkout.cleanup();
  }
}

/**
 * Where a path inside the working checkout lands inside a base worktree.
 *
 * Both sides are realpath'd before subtracting: git reports the resolved root
 * while the caller's path may run through a symlink (on macOS every $TMPDIR
 * does), and subtracting the two spellings raw yields a `../..` prefix that
 * escapes the worktree. A path that is not under the checkout at all falls back
 * to the worktree root, which is the only reading left that stays inside it.
 */
export async function pathInBaseWorktree(
  gitRoot: string,
  path: string,
  baseDir: string,
): Promise<string> {
  const gitRootReal = await realpath(gitRoot).catch(() => gitRoot);
  const pathReal = await realpath(path).catch(() => resolve(path));
  const rel = relative(gitRootReal, pathReal);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return baseDir;
  return join(baseDir, rel);
}
