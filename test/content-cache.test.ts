import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MISSING_DEP_SENTINEL,
  cacheKey,
  contentHash,
  depMark,
  pruneCache,
  withCache,
  withCacheDeps,
} from "../src/cache/content-cache.js";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "codeontic-cache-test-"));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("content-cache — hashing + keys", () => {
  it("contentHash is deterministic and content-derived (worktree-independent)", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });

  it("cacheKey is order-sensitive over its parts", () => {
    expect(cacheKey(["a", "b"])).toBe(cacheKey(["a", "b"]));
    expect(cacheKey(["a", "b"])).not.toBe(cacheKey(["b", "a"]));
  });
});

describe("withCache — read-or-compute", () => {
  it("misses then hits: compute runs once, second call returns cached without recomputing", async () => {
    let computed = 0;
    const key = cacheKey(["v1", "file", contentHash("x")]);
    const first = await withCache(cacheDir, key, () => {
      computed++;
      return { n: 42 };
    });
    const second = await withCache(cacheDir, key, () => {
      computed++;
      return { n: -1 }; // must NOT run
    });
    expect(first).toEqual({ n: 42 });
    expect(second).toEqual({ n: 42 }); // served from cache, not the -1 recompute
    expect(computed).toBe(1);
  });

  it("cold (empty cache) and warm results are byte-identical (zero cache dependency)", async () => {
    const compute = () => ({ facts: [1, 2, 3], name: "run:execute" });
    const key = cacheKey(["v1", "f", contentHash("c")]);
    const cold = await withCache(cacheDir, key, compute);
    const warm = await withCache(cacheDir, key, compute);
    expect(JSON.stringify(cold)).toBe(JSON.stringify(warm));
  });

  it("cacheDir undefined disables the cache (always recomputes, nothing written)", async () => {
    let computed = 0;
    const key = cacheKey(["v1", "f", contentHash("c")]);
    await withCache(undefined, key, () => {
      computed++;
      return 1;
    });
    await withCache(undefined, key, () => {
      computed++;
      return 1;
    });
    expect(computed).toBe(2); // no caching
  });

  it("recomputes on a corrupt cache entry instead of throwing", async () => {
    const key = cacheKey(["v1", "f", contentHash("c")]);
    // seed a corrupt entry at the sharded path
    const shard = join(cacheDir, key.slice(0, 2));
    await import("node:fs/promises").then((fs) => fs.mkdir(shard, { recursive: true }));
    await writeFile(join(shard, `${key}.json`), "{ not json", "utf8");
    const value = await withCache(cacheDir, key, () => ({ ok: true }));
    expect(value).toEqual({ ok: true });
    // and the corrupt entry got overwritten with the valid computed value.
    // On-disk shape is `{value, deps}` (adapter v2): entries now record the
    // OTHER files a result was derived from, so a change to one of those can
    // invalidate the entry.
    const onDisk = JSON.parse(await readFile(join(shard, `${key}.json`), "utf8"));
    expect(onDisk).toEqual({ value: { ok: true }, deps: {}, depsFormat: 1 });
  });
});

describe("withCacheDeps — dependency-invalidated entries", () => {
  const key = () => cacheKey(["v1", "dep-test", contentHash("c")]);

  it("serves a hit only while the verifier says every dependency still matches", async () => {
    let computed = 0;
    const compute = async () => {
      computed++;
      return { value: computed, deps: { "other.ts": depMark("v1") } };
    };
    await withCacheDeps(cacheDir, key(), compute, async () => true);
    await withCacheDeps(cacheDir, key(), compute, async () => true);
    expect(computed).toBe(1); // second call hit

    const { value } = await withCacheDeps(cacheDir, key(), compute, async () => false);
    expect(computed).toBe(2); // verifier said stale → recomputed
    expect(value).toBe(2);
  });

  /**
   * The contract that keeps a silent failure from being possible: an entry with
   * dependencies and no way to check them could be written but never matched,
   * degrading into "cache silently disabled for exactly the entries that most
   * need it". Better to be loud at the call site.
   */
  it("throws when compute() records dependencies but no verifier was supplied", async () => {
    await expect(
      withCacheDeps(cacheDir, key(), async () => ({
        value: 1,
        deps: { "other.ts": depMark("x") },
      })),
    ).rejects.toThrow(/verifyDeps/);
  });

  it("throws the same way with caching disabled — a contract bug can't hide behind --no-cache", async () => {
    await expect(
      withCacheDeps(undefined, key(), async () => ({
        value: 1,
        deps: { "other.ts": depMark("x") },
      })),
    ).rejects.toThrow(/verifyDeps/);
  });

  it("leaves the dependency-free path alone (no verifier needed, still cached)", async () => {
    let computed = 0;
    const compute = async () => {
      computed++;
      return { value: computed, deps: {} };
    };
    await withCacheDeps(cacheDir, key(), compute);
    await withCacheDeps(cacheDir, key(), compute);
    expect(computed).toBe(1);
  });

  it("the missing-dep sentinel can never collide with a real content hash", () => {
    // contentHash is 64 lowercase hex chars; the sentinel is neither.
    expect(MISSING_DEP_SENTINEL).not.toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("")).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The upgrade path. Entries written before the `{value, deps}` wrapper
   * existed are BARE values, and a bare value read as the new shape destructures
   * to `undefined` — a silent wrong answer served from a cache that looks
   * healthy. Anyone upgrading across this change has a machine cache full of
   * them, so it needs a regression test of its own rather than riding along on
   * the corrupt-JSON case.
   */
  it("treats a legacy bare-value entry as a miss instead of destructuring undefined out of it", async () => {
    const k = cacheKey(["v1", "legacy", contentHash("c")]);
    const shard = join(cacheDir, k.slice(0, 2));
    await import("node:fs/promises").then((fs) => fs.mkdir(shard, { recursive: true }));
    await writeFile(join(shard, `${k}.json`), JSON.stringify({ ok: "legacy" }), "utf8");

    let computed = 0;
    const value = await withCache(cacheDir, k, () => {
      computed++;
      return { ok: "recomputed" };
    });
    expect(computed).toBe(1); // recomputed, not served
    expect(value).toEqual({ ok: "recomputed" }); // and NOT undefined
    // rewritten in the current shape, so the next read is a normal hit
    const onDisk = JSON.parse(await readFile(join(shard, `${k}.json`), "utf8"));
    expect(onDisk).toEqual({ value: { ok: "recomputed" }, deps: {}, depsFormat: 1 });
  });

  /**
   * The upgrade hazard that no SHAPE check can catch. Entries written by the
   * pre-release build that recorded only successful reads look exactly like
   * current ones — and a probe that missed left `deps` empty, which the reader
   * would take as "no dependencies, always fresh". Adopting such an entry
   * carries the very bug the sentinel exists to fix, so the version, not the
   * shape, is what grants trust.
   */
  it("rejects a shape-identical entry that predates miss-recording (no depsFormat)", async () => {
    const k = cacheKey(["v1", "pre-sentinel", contentHash("c")]);
    const shard = join(cacheDir, k.slice(0, 2));
    await import("node:fs/promises").then((fs) => fs.mkdir(shard, { recursive: true }));
    // Indistinguishable from a current zero-dependency entry except for the version.
    await writeFile(join(shard, `${k}.json`), JSON.stringify({ value: "stale", deps: {} }), "utf8");

    let computed = 0;
    const { value } = await withCacheDeps(cacheDir, k, async () => {
      computed++;
      return { value: "recomputed", deps: {} };
    });
    expect(computed).toBe(1);
    expect(value).toBe("recomputed");
  });

  it("rejects an entry claiming a future/unknown deps format", async () => {
    const k = cacheKey(["v1", "future-fmt", contentHash("c")]);
    const shard = join(cacheDir, k.slice(0, 2));
    await import("node:fs/promises").then((fs) => fs.mkdir(shard, { recursive: true }));
    await writeFile(
      join(shard, `${k}.json`),
      JSON.stringify({ value: "from-the-future", deps: {}, depsFormat: 99 }),
      "utf8",
    );
    const { value } = await withCacheDeps(cacheDir, k, async () => ({
      value: "recomputed",
      deps: {},
    }));
    expect(value).toBe("recomputed");
  });

  /** A legacy entry that happens to be an ARRAY (facts were cached as arrays). */
  it("treats a legacy bare ARRAY entry as a miss too", async () => {
    const k = cacheKey(["v1", "legacy-array", contentHash("c")]);
    const shard = join(cacheDir, k.slice(0, 2));
    await import("node:fs/promises").then((fs) => fs.mkdir(shard, { recursive: true }));
    await writeFile(join(shard, `${k}.json`), JSON.stringify([{ name: "old" }]), "utf8");

    const value = await withCache(cacheDir, k, () => [{ name: "new" }]);
    expect(value).toEqual([{ name: "new" }]);
  });
});

describe("pruneCache — LRU cap", () => {
  it("keeps only the newest maxEntries, deleting the oldest", async () => {
    // write 5 entries with increasing mtime (sequential awaits keep order)
    for (let i = 0; i < 5; i++) {
      await withCache(cacheDir, cacheKey(["v", `f${i}`]), () => i);
    }
    const before = await countEntries(cacheDir);
    expect(before).toBe(5);
    const deleted = await pruneCache(cacheDir, 2);
    expect(deleted).toBe(3);
    expect(await countEntries(cacheDir)).toBe(2);
  });

  it("no-ops when under the cap", async () => {
    await withCache(cacheDir, cacheKey(["v", "only"]), () => 1);
    expect(await pruneCache(cacheDir, 10)).toBe(0);
  });
});

async function countEntries(dir: string): Promise<number> {
  const shards = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const s of shards) {
    if (!s.isDirectory()) continue;
    const files = await readdir(join(dir, s.name)).catch(() => []);
    n += files.filter((f) => f.endsWith(".json")).length;
  }
  return n;
}
