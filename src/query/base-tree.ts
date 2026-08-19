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
 * Every path present at `ref`, expressed relative to `relativeTo` (default: the
 * git root). Feeds anchor-existence on the base side: an anchor "exists at
 * base" iff its path is in this set.
 *
 * Three details, each of which was a silent wrong answer before:
 *  - `-t` lists TREES as well as blobs. The filesystem side calls a directory
 *    "existing" (stat succeeds, and a bare directory IS a documented anchor
 *    shape), so a blob-only base set reports every directory anchor as missing
 *    — and when the change deletes such a directory, both sides emit the same
 *    "does not exist" text, the keys match, and a real regression is scored
 *    "already broken at base".
 *  - `-z` takes git's RAW path bytes. `--name-only` alone re-quotes anything
 *    non-ASCII or space-bearing with C escapes, which no amount of stripping
 *    surrounding quotes decodes; such a path would read as absent at base.
 *  - `relativeTo` exists because anchors resolve against `--repo-root`, which
 *    may be a subdirectory of the checkout. Comparing git-root-relative paths
 *    against repo-root-relative anchors makes every anchor look absent.
 *
 * Returns undefined (not an empty set) when git fails — the caller must fail
 * closed rather than read "no files at base" as "every anchor was already
 * broken", which would wave through exactly the breakage the gate exists for.
 */
export async function repoFilesAtRef(
  gitRoot: string,
  ref: string,
  relativeTo?: string | undefined,
): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-tree", "-r", "-t", "-z", "--name-only", ref],
      {
        cwd: gitRoot,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const prefix = relativeTo ? `${relativeTo.replace(/\/+$/, "")}/` : "";
    const files = new Set<string>();
    for (const path of stdout.split("\0")) {
      if (!path) continue;
      if (!prefix) {
        files.add(path);
      } else if (path.startsWith(prefix)) {
        files.add(path.slice(prefix.length));
      }
    }
    return files;
  } catch {
    return undefined;
  }
}

export interface MaterializedModel {
  /**
   * The MODEL directory itself, ready to hand to the loader. Not the temp root:
   * the tree is rebuilt at its repo-relative path, so a model that does not sit
   * at the checkout root (`packages/app/.codeontic/model`) lands nested, and a
   * caller that assumed `<tmp>/.codeontic/model` would get ENOENT — surfaced as
   * a misleading "run codeontic init".
   */
  modelDir: string;
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
  return { modelDir: join(dir, ...modelRelDir.split("/")), cleanup };
}
