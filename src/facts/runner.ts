import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Adapter, ImplementationFact } from "../adapters/types.js";
import {
  type DepMark,
  cacheKey,
  contentHash,
  defaultCacheDir,
  depMark,
  pruneCache,
  withCacheDeps,
} from "../cache/content-cache.js";

const execFileAsync = promisify(execFile);

/** LRU cap for the machine-level cache (001 §5). */
const CACHE_MAX_ENTRIES = 50_000;

export interface FactsOptions {
  /**
   * Machine-level content cache dir (B3). Defaults to `~/.cache/codeontic`;
   * pass `null` to disable (the zero-cache-dependency path CI can take).
   */
  cacheDir?: string | null;
  /**
   * The adapter supplying the candidate pattern + extractors. REQUIRED — this
   * runner carries zero target-repo knowledge (Proposal 010: no adapter is
   * bundled in this repo; the caller resolves one via `--adapter-path` or the
   * `.codeontic/adapter/` convention path and passes it in).
   */
  adapter: Adapter;
  /**
   * Repo-relative files to scan IN ADDITION to whatever `candidatePattern`
   * matches — in practice the model's own file anchors (see
   * `modelAnchoredCandidates`).
   *
   * `candidatePattern` is a syntactic guess about where facts live, and it is
   * wrong in a specific, recurring way: the file holding a queue's authoritative
   * literal need not contain the call site the pattern looks for. A model anchor
   * is not a guess — it is a human saying "this file is part of this loop", so
   * it earns a scan regardless of what the regex thinks. Paths that don't exist
   * or aren't extractable source are dropped, so a stale anchor costs nothing.
   */
  extraCandidates?: readonly string[];
}

export interface FactsResult {
  /** false when the scan couldn't run (no git checkout) — a loud skip, not a silent empty result. */
  ran: boolean;
  skippedReason?: string;
  facts: ImplementationFact[];
  candidateFiles: number;
  filesScanned: number;
  timingMs: number;
}

/**
 * Candidate pre-filter for the fact extractors (same posture as A6's INV-1
 * scan): `git grep -l` narrows to files that mention a signal the adapter's
 * `candidatePattern` names, then the pure AST extractors confirm. Over-matching
 * only costs a cheap extra parse; under-matching would be a silent miss, so the
 * pattern is broad. Returns undefined when the target is not a usable git
 * checkout.
 */
async function gitGrepCandidates(repoRoot: string, pattern: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["grep", "-lE", pattern, "--", "*.ts", ":!*.test.ts", ":!*.spec.ts"],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    return (
      stdout
        .split("\n")
        // strip git's optional surrounding quotes on paths with special chars
        .map((l) => l.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean)
        // Belt-and-suspenders over the git pathspec exclude: also drop test/spec
        // files at the Node layer, so the result is right regardless of git
        // version / pathspec behavior.
        .filter((f) => !/\.(test|spec)\.ts$/.test(f))
    );
  } catch (err) {
    if ((err as { code?: number }).code === 1) return []; // no matches
    return undefined; // not a git repo / no git
  }
}

/**
 * Builds the repo-containment resolver: repo-relative path → absolute path, or
 * `null` when it is not a readable file inside the checkout.
 *
 * Both path sources here are repo DATA rather than engine constants — model
 * anchors (`extraCandidates`) and whatever an adapter hands to `ctx.readFile` —
 * and neither is checked for containment upstream: the anchor format permits
 * `.` and `/`, so `../../../../etc/x.ts#S` is a well-formed anchor. Confining
 * reads to the checkout keeps a malformed or hostile model from turning a scan
 * into an arbitrary-file read, and keeps foreign files out of the dependency
 * records.
 *
 * Containment is decided on the REAL path, not the textual one, because
 * `resolve` alone would accept `repo/link.ts` when that is a symlink to
 * `/etc/passwd`. Resolving also normalizes case, so on a case-insensitive
 * filesystem a path whose case differs from the checkout's is correctly
 * recognized as inside rather than rejected.
 *
 * Unresolvable (missing, unreadable, dangling symlink) collapses to the same
 * `null` as out-of-repo. That is deliberate: to every caller here the outcome is
 * "no content", which for `readDep` is a recorded MISS — precisely the case the
 * sentinel exists to invalidate later.
 *
 * Callers read the RESOLVED path this returns, and must not re-join the original
 * relative path to read again: re-joining would walk the symlinks a second time,
 * so a path swapped between check and read would be followed to its new target.
 * Reading the already-resolved path narrows that window instead of opening it.
 * It does not close it — only holding a descriptor across check-and-read would,
 * which Node's portable API surface doesn't offer. That residual race needs
 * write access to the checkout mid-scan, and anyone with that can edit
 * `.codeontic/adapter/`, which this CLI imports and executes; the containment
 * check is here to stop malformed and hostile MODEL DATA, not to sandbox an
 * attacker who already runs code.
 */
function makeRepoResolver(repoRoot: string): (rel: string) => string | null {
  let root: string;
  try {
    root = realpathSync.native(resolve(repoRoot));
  } catch {
    root = resolve(repoRoot); // repoRoot itself unresolvable → textual fallback
  }
  return (rel: string): string | null => {
    const abs = resolve(root, rel); // an absolute `rel` ignores root — caught below
    let real: string;
    try {
      real = realpathSync.native(abs);
    } catch {
      return null;
    }
    const within = relative(root, real);
    if (within === "" || within.startsWith("..") || isAbsolute(within)) return null;
    return real;
  };
}

/**
 * Extracts implementation facts from the target repo via the caller-supplied
 * adapter (Proposal 010: this runner is engine-generic and carries no default
 * adapter — every caller must resolve and pass one explicitly). Same
 * git-grep-then-pure-AST posture as A6's INV-1 scan.
 */
export async function runFacts(repoRoot: string, options: FactsOptions): Promise<FactsResult> {
  const start = performance.now();
  // `null` disables; `undefined` (default) uses the machine cache dir.
  const cacheDir = options.cacheDir === null ? undefined : (options.cacheDir ?? defaultCacheDir());
  const adapter = options.adapter;

  const inRepo = makeRepoResolver(repoRoot);

  const grepped = await gitGrepCandidates(repoRoot, adapter.candidatePattern);
  if (grepped === undefined) {
    return {
      ran: false,
      skippedReason: "fact extraction needs a git checkout (git grep unavailable at repo-root)",
      facts: [],
      candidateFiles: 0,
      filesScanned: 0,
      timingMs: performance.now() - start,
    };
  }
  // Model-anchored files join the scan set even when the pattern misses them.
  // Same `.ts`-and-not-a-test shape the git pathspec enforces, so an anchor
  // can widen WHICH files are scanned but never what counts as scannable.
  const extra = (options.extraCandidates ?? []).filter(
    (f) => f.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(f) && inRepo(f) !== null,
  );
  const candidates = [...new Set([...grepped, ...extra])];

  const facts: ImplementationFact[] = [];
  let filesScanned = 0;
  // One run reads the same referenced module many times (every file that
  // composes a name from the same shared constant). Memoized per run — including
  // the misses, so a wrong path is not re-stat'd once per candidate.
  //
  // Used by BOTH the compute path and the cache verifier on purpose: within one
  // run every consultation of a given path then sees the same bytes, so a file
  // edited mid-run cannot make `verify` and `compute` disagree about it. Sync,
  // like `extractFacts` itself (Proposal 010 §6 sync-only).
  const depCache = new Map<string, string | null>();
  const readDep = (depRel: string): string | null => {
    const memo = depCache.get(depRel);
    if (memo !== undefined) return memo; // `null` is a memoized miss, not "absent"
    const abs = inRepo(depRel);
    let text: string | null;
    try {
      text = abs === null ? null : readFileSync(abs, "utf8");
    } catch {
      text = null;
    }
    depCache.set(depRel, text);
    return text;
  };
  for (const rel of candidates) {
    const absRel = inRepo(rel);
    if (absRel === null) continue; // never read outside the checkout
    const content = await readFile(absRel, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    filesScanned++;
    // Key by (adapter version, repo-relative path, content hash): `rel` is the
    // same in every worktree of the repo, so identical content shares one entry
    // cross-worktree; the path is still part of the key so two files with the
    // same bytes at different paths don't collide.
    const key = cacheKey([adapter.version, rel, contentHash(content)]);
    // The extractor may follow a reference into ANOTHER file (adapter v2's
    // `ExtractContext.readFile`). The RUNNER does that read, so it — not the
    // adapter — knows exactly which files a result depends on, and records
    // their hashes in the cache entry. Without this the entry would be keyed on
    // `rel`'s bytes alone and editing only the referenced file would serve a
    // stale fact: "invisible" would become "confidently wrong", which for an
    // advisory tool nobody would catch.
    const { value: fileFacts } = await withCacheDeps(
      cacheDir,
      key,
      async () => {
        const deps: Record<string, DepMark> = {};
        const ctx = {
          readFile(depRel: string): string | null {
            if (depRel === rel) return content; // self-read needs no dep entry
            const text = readDep(depRel);
            // A path that resolved to NOTHING is recorded too (sentinel). An
            // extractor probing candidate module paths — `./x.ts`, `./x/index.ts`,
            // a tsconfig alias — misses most of them by design, and if a miss
            // left no trace, the file later appearing at that path would never
            // invalidate this entry: it would keep serving a fact that is
            // missing rather than stale. Same silent wrongness, mirror image.
            deps[depRel] = depMark(text);
            return text;
          },
        };
        return { value: adapter.extractFacts(rel, content, ctx), deps };
      },
      // FRESH (`true`) → serve the cached value; `false` → recompute. Every
      // recorded path must still mark identically: content changed, a file
      // vanished, or a previously-absent file now exists all mean not-fresh.
      async (recorded) => {
        for (const [depRel, mark] of Object.entries(recorded)) {
          if (depMark(readDep(depRel)) !== mark) return false;
        }
        return true;
      },
    );
    facts.push(...fileFacts);
  }
  if (cacheDir) await pruneCache(cacheDir, CACHE_MAX_ENTRIES);
  // stable order: signal, then name, then path
  facts.sort(
    (a, b) =>
      a.signal.localeCompare(b.signal) ||
      a.name.localeCompare(b.name) ||
      a.filePath.localeCompare(b.filePath),
  );
  return {
    ran: true,
    facts,
    candidateFiles: candidates.length,
    filesScanned,
    timingMs: performance.now() - start,
  };
}
