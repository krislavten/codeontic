import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import { findYamlFiles } from "./loader/find-yaml-files.js";

const execFileAsync = promisify(execFile);

/**
 * A point-in-time fingerprint attached to any side-channel file codeontic
 * writes (Decision record 004, 技术点 4, CodeGraph-inspired: side-channel
 * output must carry an explicit staleness signal instead of silently
 * looking as current as a freshly-computed one).
 *
 * `modelContentHash` is the ONLY field `isStale` compares against — it's
 * a hash over every model YAML file's own bytes, so it changes the
 * instant model data changes, independent of git (uncommitted edits,
 * detached checkouts, and non-git exports all still get a real hash).
 * `generatedAt`/`repoHead`/`repoDirty` are read-only context for a human
 * looking at the file — never treat wall-clock age or repo dirtiness as
 * a staleness signal by itself: time passing doesn't make a view wrong,
 * and a repo can be dirty for reasons unrelated to the model.
 */
export interface StalenessStamp {
  generatedAt: string;
  modelContentHash: string;
  repoHead: string | null;
  repoDirty: boolean | null;
}

/**
 * Deterministic fingerprint of every *.yaml/*.yml file under `modelDir`,
 * independent of file iteration order (sorted before hashing) and of git
 * (reads working-tree bytes directly, so uncommitted edits change the
 * hash immediately — the same "reflect the working tree, not last
 * commit" posture as the rest of loadModel). This deliberately hashes
 * the WHOLE model dir rather than per-flow/per-node: it will over-report
 * staleness when an unrelated node changes, which is the safe direction
 * for a "don't trust this without checking" signal — a false "maybe
 * stale" costs a re-run; a false "definitely fresh" costs a wrong
 * decision made on stale data.
 */
export async function computeModelContentHash(modelDir: string): Promise<string> {
  const files = (await findYamlFiles(modelDir)).sort();
  const hash = createHash("sha256");
  for (const absPath of files) {
    const relPath = relative(modelDir, absPath);
    const content = await readFile(absPath, "utf8");
    hash.update(relPath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Best-effort `git rev-parse HEAD` / `git status --porcelain` against
 * `repoRoot`. Returns `{ head: null, dirty: null }` for anything that
 * isn't a usable git checkout (no git binary, not a repo, no commits
 * yet) rather than throwing — a staleness stamp must still be produced
 * for a plain export or a fresh `git init` with no commits.
 *
 * Exported so other commands that need "which commit was this model read
 * from" (e.g. `codeontic backtest` — its `--ref` pins the COMMIT WINDOW
 * scanned, never the model tree, which is always read from whatever is on
 * disk right now) can stamp their own output without duplicating this git
 * plumbing a third time.
 */
export async function readGitInfo(
  repoRoot: string,
): Promise<{ head: string | null; dirty: boolean | null }> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot }),
    ]);
    return { head: head.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { head: null, dirty: null };
  }
}

export async function computeStalenessStamp(
  modelDir: string,
  repoRoot: string,
): Promise<StalenessStamp> {
  const [modelContentHash, gitInfo] = await Promise.all([
    computeModelContentHash(modelDir),
    readGitInfo(repoRoot),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    modelContentHash,
    repoHead: gitInfo.head,
    repoDirty: gitInfo.dirty,
  };
}

const UNKNOWN_HEAD = "unknown (not a git repo or no commits yet)";
const UNKNOWN_DIRTY = "unknown";

/**
 * Marks the opening of the banner's HTML comment. A bare `<!--` isn't
 * enough of an anchor: a generated side-channel file also embeds a
 * mermaid block (see src/views/flow-mermaid.ts / src/cli/commands/
 * view.ts), and a future caller could reasonably run
 * `parseStalenessBanner` against a whole file rather than the banner
 * text alone — the non-greedy `<!--...-->` match must not lock onto
 * some unrelated comment that happens to appear first.
 */
const BANNER_MARKER = "codeontic-staleness-stamp";

/** Renders `stamp` as an HTML comment block, prepended to a generated side-channel file. */
export function formatStalenessBanner(stamp: StalenessStamp): string {
  return [
    `<!-- ${BANNER_MARKER}`,
    "This file is a point-in-time snapshot, not a live view. Before trusting",
    "it, recompute model_content_hash (src/staleness.ts computeModelContentHash)",
    "against the current model/ dir and compare — a matching generated_at or",
    "repo_head does NOT by itself mean the model hasn't changed since.",
    `generated_at: ${stamp.generatedAt}`,
    `model_content_hash: ${stamp.modelContentHash}`,
    `repo_head: ${stamp.repoHead ?? UNKNOWN_HEAD}`,
    `repo_dirty: ${stamp.repoDirty === null ? UNKNOWN_DIRTY : stamp.repoDirty}`,
    "-->",
  ].join("\n");
}

/**
 * The only lines `parseStalenessBanner` will ever treat as a field —
 * every other line in the banner (the explanatory prose) is ignored
 * outright, even if it happens to contain a `": "` substring. Matching
 * against this fixed allowlist instead of "the first `": "` on any
 * line" means the prose is free to read naturally without the parser
 * silently misreading it as a spurious field.
 */
const BANNER_FIELD_KEYS = [
  "generated_at",
  "model_content_hash",
  "repo_head",
  "repo_dirty",
] as const;

/**
 * Inverse of `formatStalenessBanner`. Returns undefined if `text` has no
 * recognizable banner. Parses fields by splitting on lines and matching
 * each line's start against `BANNER_FIELD_KEYS` rather than building a
 * `RegExp` per field — field keys are fixed string literals here, never
 * user input, but avoiding per-call dynamic regex construction sidesteps
 * the need to reason about escaping altogether, and keeps every field's
 * value confined to its own line (a value can never accidentally
 * swallow a neighboring line the way a `.*` non-multiline capture over
 * a shared block could invite as this function grows more fields).
 */
export function parseStalenessBanner(text: string): StalenessStamp | undefined {
  const block = text.match(new RegExp(`<!--\\s*${BANNER_MARKER}([\\s\\S]*?)-->`))?.[1];
  if (!block) return undefined;

  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const key = BANNER_FIELD_KEYS.find((k) => line.startsWith(`${k}: `));
    if (key) fields.set(key, line.slice(key.length + 2).trim());
  }

  const generatedAt = fields.get("generated_at");
  const modelContentHash = fields.get("model_content_hash");
  if (!generatedAt || !modelContentHash) return undefined;

  const repoHead = fields.get("repo_head");
  const repoDirty = fields.get("repo_dirty");
  return {
    generatedAt,
    modelContentHash,
    repoHead: repoHead && repoHead !== UNKNOWN_HEAD ? repoHead : null,
    repoDirty: repoDirty === "true" ? true : repoDirty === "false" ? false : null,
  };
}

/**
 * Whether a previously-generated stamp no longer reflects the current
 * model. Compares `modelContentHash` ONLY — see the field's docstring on
 * `StalenessStamp` for why wall-clock time and repo dirtiness must not
 * factor in.
 */
export function isStale(generated: StalenessStamp, current: StalenessStamp): boolean {
  return generated.modelContentHash !== current.modelContentHash;
}
