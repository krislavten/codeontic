import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelGraph } from "../loader/model-graph.js";
import { allNodes } from "../loader/model-graph.js";
import { testTextAnchorLabel } from "../schema/model.js";
import { anchorFilePath } from "../validate/anchor.js";

const execFileAsync = promisify(execFile);

/**
 * `--diff` incremental support (Proposal 006 B2 / 001 §5 §6): resolve what a PR
 * changed so a check re-runs only over the diff closure instead of the whole
 * repo, and map the changed files back to the model nodes they touch.
 */

/**
 * Repo-relative paths changed between `merge-base(baseRef, HEAD)` and the
 * working tree (committed + uncommitted), via git. Uses the merge-base (not a
 * raw `baseRef..HEAD`) so a stale base branch doesn't inflate the diff with
 * commits already on HEAD. Returns undefined when the ref/repo is unusable —
 * the caller falls back to a full scan rather than silently checking nothing.
 */
export async function changedFiles(
  gitRoot: string,
  baseRef: string,
): Promise<string[] | undefined> {
  try {
    const { stdout: mb } = await execFileAsync("git", ["merge-base", baseRef, "HEAD"], {
      cwd: gitRoot,
    });
    const base = mb.trim();
    // `git diff --name-only <base>` compares base..working-tree (includes
    // uncommitted edits), which is what a pre-push / local check wants.
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", base], {
      cwd: gitRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
  } catch {
    return undefined; // bad ref / not a git repo / no merge-base
  }
}

/** The git top-level of `dir`, or undefined if `dir` isn't inside a git checkout. */
export async function gitRootOf(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export interface AffectedNode {
  nodeId: string;
  kind: string;
  /** the anchor whose file is in the changed set */
  anchor: string;
  file: string;
}

/**
 * Model nodes whose anchor points at one of `changedFiles` — the diff's impact
 * surface on the model. Pure. A loop/junction/scenario is "affected" when a
 * file it anchors to (Loop.anchors, Junction.evidence[].anchor,
 * Scenario.verified_by[]) changed, so a reviewer sees which modeled behaviors a
 * diff might have moved out from under.
 */
export function affectedNodes(graph: ModelGraph, changed: Iterable<string>): AffectedNode[] {
  // Normalize both sides to forward slashes: git emits POSIX paths and anchors
  // are authored with `/`, but normalizing guards any backslash that slips in.
  const posix = (p: string) => p.replace(/\\/g, "/");
  const changedSet = new Set([...changed].map(posix));
  const out: AffectedNode[] = [];
  const considerFile = (nodeId: string, kind: string, anchor: string, file: string) => {
    if (changedSet.has(posix(file))) out.push({ nodeId, kind, anchor, file });
  };
  const consider = (nodeId: string, kind: string, anchor: string) => {
    const file = anchorFilePath(anchor);
    if (file) considerFile(nodeId, kind, anchor, file);
  };
  for (const node of allNodes(graph)) {
    if (node.kind === "loop") {
      for (const a of node.anchors) consider(node.id, "loop", a);
    } else if (node.kind === "flow") {
      // F1: flows carry their own anchors. Omitting them here makes a diff that
      // touches a flow-anchored file look like it moved nothing in the model.
      for (const a of node.anchors) consider(node.id, "flow", a);
    } else if (node.kind === "junction") {
      for (const e of node.evidence) consider(node.id, "junction", e.anchor);
    } else if (node.kind === "scenario") {
      for (const a of node.verified_by) consider(node.id, "scenario", a);
      // Text anchors point at a file too — a diff touching it moves the test
      // this scenario stands on, which is exactly what this view is for.
      for (const t of node.verified_by_text)
        considerFile(node.id, "scenario", testTextAnchorLabel(t), t.file);
    }
  }
  return out;
}

/**
 * Debt ids present in the model at `baseRef`, for the baseline-only-decreases
 * check's "before" snapshot. `modelRelDir` is the model directory relative to
 * `gitRoot`. Uses a SINGLE `git grep` over the base tree (not one `git show`
 * per model file) so it stays fast on a large model.
 *
 * Returns undefined only when the base snapshot is genuinely unreadable (bad
 * ref / not a git repo); an empty set (no debt at base) is a real result, not a
 * skip. Note: the id scrape is a text match — only DebtEntry nodes can carry a
 * `DEBT-` id (the schema's id regexes forbid it elsewhere), and a stray match
 * in a comment/string could at worst add a spurious "before" id, which only
 * *suppresses* a growth violation, never invents one (checkBaselineOnlyDecreases
 * flags after-not-before).
 */
export async function debtIdsAtRef(
  gitRoot: string,
  modelRelDir: string,
  baseRef: string,
): Promise<Set<string> | undefined> {
  let base: string;
  try {
    base = (
      await execFileAsync("git", ["merge-base", baseRef, "HEAD"], { cwd: gitRoot })
    ).stdout.trim();
  } catch {
    return undefined; // bad ref / not a git repo
  }
  let stdout: string;
  try {
    // POSIX ERE (git grep -E) — `[[:space:]]`, not `\s` (that's PCRE). A pathspec
    // is only appended when non-empty (modelRelDir is always `.../model` in
    // practice, but an empty/`.` pathspec after `--` would be ambiguous).
    const pattern = 'id:[[:space:]]*"?DEBT-[A-Za-z0-9-]+';
    const args =
      modelRelDir && modelRelDir !== "."
        ? ["grep", "-hE", pattern, base, "--", modelRelDir]
        : ["grep", "-hE", pattern, base];
    ({ stdout } = await execFileAsync("git", args, { cwd: gitRoot, maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    // git grep exits 1 when there are simply no matches — that's an empty debt
    // baseline (a real result), not a failure.
    if ((err as { code?: number }).code === 1) return new Set();
    return undefined;
  }
  const ids = new Set<string>();
  for (const m of stdout.matchAll(/id:\s*"?(DEBT-[A-Za-z0-9-]+)"?/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}
