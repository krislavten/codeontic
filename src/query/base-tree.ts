import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Reading a git ref's tree WITHOUT checking it out.
 *
 * The `gate` command needs to know what the model and the repo looked like at
 * a base ref, so it can tell "this PR broke it" from "it was already broken".
 * The obvious way is `git worktree add` + a second full scan, which is what the
 * first consumer of this idea hand-rolled in its CI: it costs a checkout of the
 * whole repo, needs disk, and adds two failure modes (the add can fail, the
 * leftover directory collides with the next step's worktree at the same path).
 *
 * None of that is necessary. Only the ERROR-severity checks gate, and none of
 * them read repo file CONTENT — they need the model's YAML (small, `git show`)
 * and the answer to "does this path exist at the base" (`git ls-tree`). So the
 * base side is two git plumbing calls and no checkout at all.
 */

/** `merge-base(ref, HEAD)`, matching `--diff`'s semantics, or undefined if unresolvable. */
export async function mergeBaseOf(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", ref, "HEAD"], { cwd: gitRoot });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every repo-relative path present at `ref`. Feeds anchor-existence on the base
 * side: an anchor "exists at base" iff its path is in this set.
 *
 * Returns undefined (not an empty set) when git fails — the caller must fail
 * closed rather than read "no files at base" as "every anchor was already
 * broken", which would wave through exactly the breakage the gate exists for.
 */
export async function repoFilesAtRef(
  gitRoot: string,
  ref: string,
): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", ref], {
      cwd: gitRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = new Set<string>();
    for (const line of stdout.split("\n")) {
      const path = line.trim().replace(/^"(.*)"$/, "$1");
      if (path) files.add(path);
    }
    return files;
  } catch {
    return undefined;
  }
}

export interface MaterializedModel {
  /** Directory holding `.codeontic/model/…` as it was at the ref. */
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Writes the model as it existed at `ref` into a temp dir shaped like a target
 * repo (`<tmp>/.codeontic/model/…`), so the normal loader can read it. Only the
 * model tree is materialized — a few dozen small YAML files, not the repo.
 *
 * Returns undefined when the ref has no model directory or git fails; the
 * caller fails closed.
 */
export async function materializeModelAtRef(
  gitRoot: string,
  modelRelDir: string,
  ref: string,
): Promise<MaterializedModel | undefined> {
  let paths: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-tree", "-r", "--name-only", ref, "--", modelRelDir],
      { cwd: gitRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    paths = stdout
      .split("\n")
      .map((l) => l.trim().replace(/^"(.*)"$/, "$1"))
      .filter((l) => l.endsWith(".yaml") || l.endsWith(".yml"));
  } catch {
    return undefined;
  }
  if (paths.length === 0) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "codeontic-base-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    for (const path of paths) {
      const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], {
        cwd: gitRoot,
        maxBuffer: 32 * 1024 * 1024,
      });
      // `path` comes from git's own tree listing under modelRelDir, so it is
      // repo-relative and already normalized; rebuild it under the temp root.
      const destination = join(dir, ...path.split(posix.sep));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, stdout, "utf8");
    }
  } catch {
    await cleanup();
    return undefined;
  }
  return { dir, cleanup };
}
