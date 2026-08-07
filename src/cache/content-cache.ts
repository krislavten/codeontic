import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Machine-level content-addressed cache (Proposal 006 B3 / 001 §5) for the pure
 * per-file extractor/scanner results (A6 INV-1 scan, B1 fact extraction).
 *
 * Key = sha256 over caller-supplied parts — for the fact extractor,
 * (adapter_version, repo-relative path, content_hash). Every part is
 * worktree-INDEPENDENT: the content hash is by definition, and the
 * repo-relative path is the same in every worktree of the repo. So identical
 * bytes at the same in-repo path share ONE entry across the user's many
 * worktrees (the cross-worktree sharing 001 §5 calls for), while the path stays
 * in the key so two files with the same bytes at DIFFERENT paths don't collide
 * (the cached value embeds its path). Content-addressing also makes writes
 * idempotent: a given key's value is deterministic, so a concurrent write of
 * the same key is harmless (both write identical bytes; temp+rename just makes
 * each atomic).
 *
 * Correctness has ZERO cache dependency (001 §6 red line): the value is exactly
 * `compute()` — a cold run (empty cache) and a warm run are byte-identical, and
 * a missing/corrupt/disabled cache just recomputes. `cacheDir: undefined`
 * disables it entirely (the path CI can take to prove independence).
 *
 * Not modeled (documented deferral): the git-index fast-path for reading a
 * clean tracked file's blob OID without re-hashing. Hashing the content
 * directly is always correct and worktree-identical; the index lookup is only a
 * micro-optimization, so B3 ships the always-correct content-hash path.
 */

export function defaultCacheDir(): string {
  return join(homedir(), ".cache", "codeontic");
}

/** sha256 of a file's content — the worktree-independent part of the cache key. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The cache key: a hash over the ordered key parts (adapter version, content hash, config hash). */
export function cacheKey(parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p);
    h.update("\0");
  }
  return h.digest("hex");
}

function entryPath(cacheDir: string, key: string): { shard: string; path: string } {
  const shard = join(cacheDir, key.slice(0, 2)); // 2-char shard: bounds any one dir's fan-out
  return { shard, path: join(shard, `${key}.json`) };
}

/**
 * Read-or-compute. On a hit, returns the parsed cached value; on a miss (or
 * disabled/corrupt cache), computes, atomically writes (temp + rename), and
 * returns. `compute` must be a PURE function of the same inputs the key was
 * derived from — that's what makes the cache sound. `compute` may be sync or
 * async (`await` handles both).
 */
/**
 * Recorded in `deps` for a path the computation TRIED to read and could not.
 *
 * A dependency is not only "a file I read" — it is equally "a file I looked for
 * and did not find", because the answer would have been different had it
 * existed. Recording only successful reads leaves the mirror-image of the bug
 * this whole mechanism exists to prevent: a path that resolved to nothing gets
 * no entry, so the result looks dependency-free, and the file later APPEARING
 * never invalidates anything. The entry then keeps serving a fact that is
 * missing rather than one that is stale — same silent wrongness, opposite
 * direction.
 *
 * Cannot collide with a real value: `contentHash` returns 64 lowercase hex
 * chars, and this is neither. Prefer {@link depMark} over writing it yourself —
 * the sentinel is an in-band encoding (entries are JSON on disk, so it has to
 * be a string), and one shared writer is what keeps it from becoming a
 * convention each caller re-implements slightly differently.
 */
export const MISSING_DEP_SENTINEL = "\0missing";

declare const depMarkBrand: unique symbol;
/**
 * A `deps` value. Branded so it can only come from {@link depMark} — a plain
 * string won't typecheck, which is what makes "one writer" a property of the
 * code rather than a convention in a comment. Erased at runtime; entries are
 * still plain strings on disk.
 */
export type DepMark = string & { readonly [depMarkBrand]: true };

/**
 * The value to record in `deps` for one consulted path: its content hash when
 * read, the missing-sentinel when not. The single writer for both cases.
 */
export function depMark(content: string | null): DepMark {
  return (content === null ? MISSING_DEP_SENTINEL : contentHash(content)) as DepMark;
}

/**
 * Bumped when the meaning of a `deps` map changes, NOT merely its shape.
 *
 * Version 1 is "every consulted path is recorded, misses included". The
 * pre-release format that recorded only successful reads is indistinguishable
 * from it by shape alone — both are `{value, deps}`, and a probe that missed
 * simply left `deps` empty, which the reader would then treat as "no
 * dependencies, always fresh". That is exactly the bug the sentinel fixes, so
 * an entry that predates the sentinel must not be trusted: unversioned entries
 * are recomputed rather than adopted.
 */
const DEPS_FORMAT_VERSION = 1;

/**
 * A cached value plus the OTHER files it was derived from.
 *
 * A content-addressed entry keyed only by its own file's hash is correct right
 * up until an extractor reads a second file — after that, editing that second
 * file alone leaves the entry stale while its key still matches. Recording the
 * dependency hashes lets the reader detect exactly that and recompute.
 */
export interface CachedWithDeps<T> {
  value: T;
  /**
   * repo-relative path → {@link depMark} of that path at the time the value was
   * computed. EVERY path the computation consulted appears here, including ones
   * that could not be read.
   */
  deps: Record<string, DepMark>;
}

/** On-disk form: {@link CachedWithDeps} plus the format version. */
interface CacheEntryOnDisk<T> extends CachedWithDeps<T> {
  depsFormat: number;
}

export async function withCache<T>(
  cacheDir: string | undefined,
  key: string,
  compute: () => T | Promise<T>,
): Promise<T> {
  const { value } = await withCacheDeps(cacheDir, key, async () => ({
    value: await compute(),
    deps: {},
  }));
  return value;
}

/**
 * `withCache` for computations that may read other files.
 *
 * `compute` returns both the value and the dependency hashes it consulted. On
 * read, an entry is only a HIT when every recorded dependency still matches —
 * `verifyDeps` is asked to re-check them, returning `true` for FRESH (serve the
 * cached value) and `false` for stale (recompute). A dependency that changed,
 * disappeared, or newly APPEARED makes it a miss, so neither the stale-fact nor
 * the missing-fact hazard above can happen.
 *
 * `verifyDeps` is optional only because a dependency-free computation genuinely
 * doesn't need one. Producing dependencies WITHOUT supplying a verifier is a
 * caller bug and throws: without it every such entry would be written and then
 * never be able to match, degrading silently into "cache disabled for exactly
 * the entries that most need it" — the kind of quiet failure this module is
 * built to avoid.
 */
export async function withCacheDeps<T>(
  cacheDir: string | undefined,
  key: string,
  compute: () => Promise<CachedWithDeps<T>>,
  verifyDeps?: (deps: Record<string, DepMark>) => Promise<boolean>,
): Promise<CachedWithDeps<T>> {
  // Checked on every path, including cache-disabled: CI routinely runs
  // `--no-cache`, and a contract violation that only surfaces on cached runs is
  // one that ships.
  //
  // This is a programming error in the CALLER, not a runtime condition — it
  // cannot be caused by any repo state, only by wiring compute and verify
  // inconsistently. Callers must not catch it into a degraded path: doing so
  // reinstates the silent half-working cache it exists to prevent.
  const assertVerifiable = (entry: CachedWithDeps<T>): CachedWithDeps<T> => {
    if (!verifyDeps && Object.keys(entry.deps).length > 0) {
      throw new Error(
        `withCacheDeps: compute() recorded ${Object.keys(entry.deps).length} dependency/ies for key ${key} but no verifyDeps was supplied — such an entry could never be validated on read`,
      );
    }
    return entry;
  };

  if (!cacheDir) return assertVerifiable(await compute()); // caching disabled

  const { shard, path } = entryPath(cacheDir, key);
  const cached = await readFile(path, "utf8").catch(() => undefined);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      // Two generations of older entry have to be rejected here, and only one
      // of them is visible by shape:
      //   - BARE values, written before the `{value, deps}` wrapper existed.
      //     Read as the new shape they yield `undefined` for the value.
      //   - `{value, deps}` entries from before misses were recorded. Shape-
      //     identical to a current one; a probe that missed just left `deps`
      //     empty, which reads as "no dependencies, always fresh" — precisely
      //     the bug the sentinel fixes, preserved in the cache.
      // Hence the explicit version, not a structural check: only an entry that
      // SAYS it records misses may be trusted to have recorded them.
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("value" in parsed) ||
        !("deps" in parsed) ||
        (parsed as { depsFormat?: unknown }).depsFormat !== DEPS_FORMAT_VERSION
      ) {
        throw new Error("legacy or malformed cache entry");
      }
      const entry = parsed as CacheEntryOnDisk<T>;
      const deps = entry.deps ?? {};
      // No deps → nothing to re-check, the key alone is sufficient. Otherwise
      // the verifier decides; absent one we cannot validate, so treat as miss
      // (the recompute below then throws the contract error above rather than
      // looping over an entry it can never accept).
      const fresh = Object.keys(deps).length === 0 || (verifyDeps ? await verifyDeps(deps) : false);
      if (fresh) {
        // Bump mtime on HIT so it reflects last ACCESS, not last write — a
        // content-addressed entry is never rewritten, so without this the LRU
        // (pruneCache, mtime-sorted) would evict frequently-read hot entries as if
        // they were stale. Best-effort: a failed touch just makes the LRU slightly
        // less accurate, never breaks the read.
        await utimes(path, new Date(), new Date()).catch(() => undefined);
        return entry;
      }
      // A dependency moved → fall through and recompute. NOT an error: this is
      // the mechanism working, not a corrupt entry.
    } catch {
      // corrupt entry (e.g. a torn write from an old non-atomic writer) → recompute + overwrite
    }
  }

  const entry = assertVerifiable(await compute());
  await mkdir(shard, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const onDisk: CacheEntryOnDisk<T> = { ...entry, depsFormat: DEPS_FORMAT_VERSION };
  await writeFile(tmp, JSON.stringify(onDisk), "utf8");
  // A concurrent writer of the same key wrote identical bytes — rename is still
  // fine; swallow a rare rename error rather than fail the run over the cache.
  await rename(tmp, path).catch(() => undefined);
  return entry;
}

/**
 * Bounds the cache to `maxEntries` most-recently-modified entries (the LRU cap
 * from 001 §5). Cheap and best-effort — called once per run, not per file — so
 * an occasional over-count between prunes is fine.
 */
export async function pruneCache(cacheDir: string, maxEntries: number): Promise<number> {
  const shards = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const entries: { path: string; mtimeMs: number }[] = [];
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const shardDir = join(cacheDir, shard.name);
    const files = await readdir(shardDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const p = join(shardDir, f);
      const s = await stat(p).catch(() => undefined);
      if (s) entries.push({ path: p, mtimeMs: s.mtimeMs });
    }
  }
  if (entries.length <= maxEntries) return 0;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const toDelete = entries.slice(0, entries.length - maxEntries);
  let deleted = 0;
  for (const e of toDelete) {
    await unlink(e.path)
      .then(() => {
        deleted++;
      })
      .catch(() => undefined);
  }
  return deleted;
}
