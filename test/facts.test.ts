import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, ImplementationFact } from "../src/adapters/types.js";
import { runFacts } from "../src/facts/runner.js";

/**
 * Synthetic adapter for engine-generic runner tests (Proposal 010 — no
 * adapter ships with this engine; a target-specific adapter's own extractor
 * unit tests live in that target repo, see Proposal 010 §5.1). Mirrors the
 * shape of a real signal (const-decl + call-site + setInterval) without
 * encoding any target's business vocabulary.
 */
const syntheticAdapter: Adapter = {
  interfaceVersion: "v2",
  name: "synthetic",
  version: "synthetic-1",
  candidatePattern: "JOB_QUEUE|setInterval",
  extractFacts(filePath: string, content: string): ImplementationFact[] {
    const facts: ImplementationFact[] = [];
    const queueMatch = content.match(/const JOB_QUEUE = `job:run\$\{QUEUE_SUFFIX\}`;/);
    if (queueMatch) {
      facts.push({
        signal: "synthetic_queue",
        name: "job:run",
        filePath,
        line: 1,
        detail: "env-templated",
      });
    }
    if (content.includes("setInterval")) {
      facts.push({ signal: "synthetic_poller", name: `poll@${filePath}`, filePath, line: 2 });
    }
    return facts;
  },
};

describe("runFacts — end-to-end over a git fixture (engine-generic runner)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-facts-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(
      join(repo, "src", "worker.ts"),
      "const JOB_QUEUE = `job:run${QUEUE_SUFFIX}`;\nsetInterval(() => poll(), 5000);\n",
    );
    await writeFile(join(repo, "src", "plain.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("git-grep pre-filters candidates and extracts facts via the caller-supplied adapter", async () => {
    const r = await runFacts(repo, { adapter: syntheticAdapter });
    expect(r.ran).toBe(true);
    expect(r.candidateFiles).toBe(1); // only worker.ts matches the pre-filter
    expect(r.facts.map((f) => f.signal).sort()).toEqual(["synthetic_poller", "synthetic_queue"]);
    expect(r.facts.find((f) => f.signal === "synthetic_queue")?.name).toBe("job:run");
    expect(r.timingMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * THE `topology` FIELD MUST SURVIVE THE CACHE. The test above compares
   * cold/warm/off byte-for-byte, but `syntheticAdapter` emits no `topology`
   * hint — so a serialization that silently DROPPED the field would still
   * make that test pass: absent on both sides is still equal.
   *
   * That is the exact failure this repo keeps hunting: a field that quietly
   * stops existing, with no error and no warning (the same shape as
   * `mechanism` being stripped by a non-strict zod on an older release). The
   * topology view is built entirely out of this field, so if the cache ate
   * it, the second run of any nightly would render an empty graph and look
   * like the repo simply has no edges.
   */
  it("B3 cache round-trips the optional `topology` hint — a dropped field would render an empty graph, silently", async () => {
    // Keyed off the shared `repo` fixture's `src/worker.ts`, which contains a
    // `setInterval` (see beforeEach). The assertions below are written against
    // "however many the cold run produced", not a hardcoded count, so changing
    // that fixture cannot turn this into a confusing failure — it only has to
    // keep producing at least one match.
    const topologyAdapter: Adapter = {
      ...syntheticAdapter,
      name: "synthetic-topology",
      version: "synthetic-topology-1",
      extractFacts(filePath: string, content: string): ImplementationFact[] {
        return content.includes("setInterval")
          ? [
              {
                signal: "outbound_edge",
                name: "SOME_SERVICE_URL",
                filePath,
                line: 2,
                topology: { to: "some-service", toKind: "service", via: "SOME_SERVICE_URL" },
              },
            ]
          : [];
      },
    };
    const cacheDir = await mkdtemp(join(tmpdir(), "codeontic-topology-cache-"));
    try {
      const cold = await runFacts(repo, { cacheDir, adapter: topologyAdapter });
      const warm = await runFacts(repo, { cacheDir, adapter: topologyAdapter }); // served from cache
      // Guard the guard: without this, a cold run that stopped producing the
      // hint at all would make the equality below pass for the wrong reason.
      // Counted, not indexed — nothing promises a fact's position, and this
      // assertion must fail on "field vanished", not on "order changed".
      const coldHints = cold.facts.filter((f) => f.topology);
      const warmHints = warm.facts.filter((f) => f.topology);
      expect(coldHints.length).toBeGreaterThan(0);
      // Compared as whole lists, never by index: this assertion has to fail on
      // "the field vanished", not on "the order moved".
      expect(warmHints.map((f) => f.topology)).toEqual(coldHints.map((f) => f.topology));
      expect(coldHints.map((f) => f.topology)).toContainEqual({
        to: "some-service",
        toKind: "service",
        via: "SOME_SERVICE_URL",
      });
      // Byte-identical cold-vs-warm is this repo's EXISTING cache contract, not
      // an assumption introduced here — the neighbouring "cold and warm runs are
      // byte-identical" test asserts exactly this on the same runner. Keeping the
      // same comparison means a cache change that reorders facts is caught by
      // both, instead of one of them quietly tolerating it.
      expect(JSON.stringify(warm.facts)).toBe(JSON.stringify(cold.facts));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("B3 cache: cold and warm runs are byte-identical, and equal the cache-disabled run", async () => {
    const { mkdtemp: mkd } = await import("node:fs/promises");
    const cacheDir = await mkd(join(tmpdir(), "codeontic-facts-cache-"));
    try {
      const cold = await runFacts(repo, { cacheDir, adapter: syntheticAdapter });
      const warm = await runFacts(repo, { cacheDir, adapter: syntheticAdapter }); // served from cache
      const off = await runFacts(repo, { cacheDir: null, adapter: syntheticAdapter }); // zero-dependency path
      expect(JSON.stringify(warm.facts)).toBe(JSON.stringify(cold.facts));
      expect(JSON.stringify(off.facts)).toBe(JSON.stringify(cold.facts));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("reports a loud skip (not silent empty) against a non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "codeontic-facts-nongit-"));
    try {
      const r = await runFacts(nonGit, { adapter: syntheticAdapter });
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toMatch(/git/);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});

/**
 * Adapter v2: an extractor may follow a reference into ANOTHER file via
 * `ctx.readFile`. The runner performs that read, so it knows the result's
 * dependencies and records their hashes in the cache entry.
 *
 * The cache-invalidation case below is the entire reason the interface takes
 * this shape. If the adapter did its own I/O, a fact derived from file B would
 * live in an entry keyed only on file A's bytes — editing B alone would serve
 * a stale fact. For an advisory tool that is strictly worse than not
 * extracting at all: "invisible" becomes "confidently wrong", and nobody looks.
 */
describe("runFacts — adapter v2 cross-file resolution", () => {
  let repo: string;
  let cacheDir: string;

  /** Resolves `const NAME = BASE_CONST;` by reading the module that defines it. */
  const crossFileAdapter: Adapter = {
    interfaceVersion: "v2",
    name: "cross-file",
    version: "cross-file-1",
    candidatePattern: "QUEUE",
    extractFacts(filePath, content, ctx) {
      const m = content.match(/const QUEUE = ([A-Z_]+);/);
      if (!m || !ctx) return [];
      const base = ctx.readFile("src/constants.ts");
      const lit = base?.match(new RegExp(`export const ${m[1]} = "([^"]+)"`));
      if (!lit) return [];
      return [{ signal: "synthetic_queue", name: lit[1] as string, filePath, line: 1 }];
    },
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-xfile-repo-"));
    cacheDir = await mkdtemp(join(tmpdir(), "codeontic-xfile-cache-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "constants.ts"), 'export const BASE = "job:run";\n');
    await writeFile(join(repo, "src", "use.ts"), "const QUEUE = BASE;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("resolves a name that only exists in another file", async () => {
    const r = await runFacts(repo, { adapter: crossFileAdapter });
    expect(r.facts.map((f) => f.name)).toContain("job:run");
  });

  /** The point of recording dependencies. */
  it("re-extracts when only the REFERENCED file changed", async () => {
    const first = await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    expect(first.facts.map((f) => f.name)).toContain("job:run");

    // `use.ts` is untouched, so its own content hash — the primary cache key —
    // is unchanged. Only the file it points at moved.
    await writeFile(join(repo, "src", "constants.ts"), 'export const BASE = "job:renamed";\n');
    execFileSync("git", ["add", "-A"], { cwd: repo });

    const second = await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    expect(second.facts.map((f) => f.name)).toContain("job:renamed");
    expect(second.facts.map((f) => f.name)).not.toContain("job:run");
  });

  it("serves from cache when nothing moved", async () => {
    await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    const again = await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    expect(again.facts.map((f) => f.name)).toContain("job:run");
  });

  /** A v1-shaped adapter (no ctx use) must keep working unchanged. */
  it("leaves an extractor that ignores ctx completely unaffected", async () => {
    const r = await runFacts(repo, {
      adapter: {
        ...crossFileAdapter,
        name: "no-ctx",
        extractFacts: (filePath, content) =>
          content.includes("QUEUE")
            ? [{ signal: "synthetic_queue", name: "static", filePath, line: 1 }]
            : [],
      },
      cacheDir,
    });
    expect(r.facts.map((f) => f.name)).toContain("static");
  });

  /**
   * The mirror image of "re-extracts when only the REFERENCED file changed",
   * and the one that a hash-only dependency record gets wrong: a path that
   * resolved to NOTHING is still a dependency, because the answer would have
   * differed had it existed. Record only successful reads and the entry looks
   * dependency-free, so the file later APPEARING invalidates nothing and the
   * cache keeps serving a fact that is missing rather than stale.
   */
  it("re-extracts when a referenced file that was ABSENT is created", async () => {
    await rm(join(repo, "src", "constants.ts"));
    execFileSync("git", ["add", "-A"], { cwd: repo });

    const first = await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    expect(first.facts).toEqual([]); // nothing to resolve against yet

    // `use.ts` is byte-identical, so the primary key is unchanged. The only
    // thing that moved is a file the previous run looked for and did not find.
    await writeFile(join(repo, "src", "constants.ts"), 'export const BASE = "job:appeared";\n');
    execFileSync("git", ["add", "-A"], { cwd: repo });

    const second = await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    expect(second.facts.map((f) => f.name)).toContain("job:appeared");
  });

  /** A probe that stays unresolved must not thrash the cache either. */
  it("still serves from cache when an absent referenced file is still absent", async () => {
    await rm(join(repo, "src", "constants.ts"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    const again = await runFacts(repo, { adapter: crossFileAdapter, cacheDir });
    expect(again.facts).toEqual([]);
  });
});

/**
 * `candidatePattern` is a syntactic guess about where facts live; a model
 * anchor is a human statement that a file belongs to a loop. When the two
 * disagree the anchor wins, because the recurring real-world miss is exactly
 * this: the file holding a queue's authoritative literal contains no call site
 * for the pattern to match.
 */
describe("runFacts — model anchors widen the scan set", () => {
  let repo: string;

  const constDeclAdapter: Adapter = {
    interfaceVersion: "v2",
    name: "const-decl",
    version: "const-decl-1",
    // Matches the CALL SITE only — deliberately blind to the declaration file.
    candidatePattern: "boss\\.work\\(",
    extractFacts(filePath, content) {
      const m = content.match(/export const [A-Z_]+ = "([^"]+)";/);
      return m ? [{ signal: "synthetic_queue", name: m[1] as string, filePath, line: 1 }] : [];
    },
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-anchor-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "plan-worker.ts"), 'export const PLAN = "plan:queue";\n');
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("misses a declaration-only file when nothing but the pattern drives discovery", async () => {
    // Negative control: without this the anchor test below could pass for the
    // wrong reason (pattern already matching).
    const r = await runFacts(repo, { adapter: constDeclAdapter, cacheDir: null });
    expect(r.facts).toEqual([]);
  });

  it("scans an anchored file the candidatePattern does not match", async () => {
    const r = await runFacts(repo, {
      adapter: constDeclAdapter,
      cacheDir: null,
      extraCandidates: ["src/plan-worker.ts"],
    });
    expect(r.facts.map((f) => f.name)).toEqual(["plan:queue"]);
  });

  it("ignores anchors that are not extractable source (db tables, docs, tests)", async () => {
    const r = await runFacts(repo, {
      adapter: constDeclAdapter,
      cacheDir: null,
      extraCandidates: ["sandboxes", "docs/spec.md", "src/plan-worker.test.ts"],
    });
    expect(r.facts).toEqual([]);
    expect(r.candidateFiles).toBe(0);
  });

  it("does not double-scan a file the pattern already found", async () => {
    await writeFile(join(repo, "src", "both.ts"), 'boss.work("x");\nexport const B = "b:q";\n');
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const r = await runFacts(repo, {
      adapter: constDeclAdapter,
      cacheDir: null,
      extraCandidates: ["src/both.ts"],
    });
    expect(r.facts.map((f) => f.name)).toEqual(["b:q"]); // once, not twice
    expect(r.candidateFiles).toBe(1);
  });

  /** A stale anchor pointing at a deleted file must not break the run. */
  it("tolerates an anchor whose file no longer exists", async () => {
    const r = await runFacts(repo, {
      adapter: constDeclAdapter,
      cacheDir: null,
      extraCandidates: ["src/deleted.ts"],
    });
    expect(r.ran).toBe(true);
    expect(r.facts).toEqual([]);
    expect(r.filesScanned).toBe(0); // counted as a candidate, honestly not scanned
  });

  /**
   * Anchors are repo DATA, and the anchor format check permits `.` and `/` — so
   * `../../../../etc/x.ts#S` is a well-formed anchor. Widening discovery with
   * them must not widen WHERE the engine reads.
   */
  it("refuses anchors that escape the repo root, even when the target really exists", async () => {
    // A real file outside the repo, so a pass here would be a genuine read.
    const outside = await mkdtemp(join(tmpdir(), "codeontic-outside-"));
    await writeFile(join(outside, "secret.ts"), 'export const S = "leaked:queue";\n');
    try {
      const outward = `${relative(repo, outside).split(sep).join("/")}/secret.ts`;
      expect(outward.startsWith("..")).toBe(true); // the fixture really does point outward

      const r = await runFacts(repo, {
        adapter: constDeclAdapter,
        cacheDir: null,
        extraCandidates: [outward, "/etc/passwd.ts", join(outside, "secret.ts")],
      });
      expect(r.facts).toEqual([]); // nothing from outside the checkout
      expect(r.candidateFiles).toBe(0); // and they never became candidates
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  /**
   * The escape a textual check cannot see: the path is spelled entirely inside
   * the repo, and only the filesystem knows it leaves. Containment therefore has
   * to be decided on the resolved path.
   */
  it("refuses a symlink inside the repo that points out of it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "codeontic-outside-link-"));
    await writeFile(join(outside, "secret.ts"), 'export const S = "leaked:queue";\n');
    try {
      await symlink(join(outside, "secret.ts"), join(repo, "src", "innocent.ts"));
      const r = await runFacts(repo, {
        adapter: constDeclAdapter,
        cacheDir: null,
        extraCandidates: ["src/innocent.ts"], // spelled repo-relative, resolves outward
      });
      expect(r.facts).toEqual([]);
      expect(r.candidateFiles).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  /** …while an ordinary in-repo symlink stays readable. */
  it("still follows a symlink that stays inside the repo", async () => {
    await writeFile(join(repo, "src", "real.ts"), 'export const R = "inside:queue";\n');
    await symlink(join(repo, "src", "real.ts"), join(repo, "src", "alias.ts"));
    const r = await runFacts(repo, {
      adapter: constDeclAdapter,
      cacheDir: null,
      extraCandidates: ["src/alias.ts"],
    });
    expect(r.facts.map((f) => f.name)).toEqual(["inside:queue"]);
  });
});
