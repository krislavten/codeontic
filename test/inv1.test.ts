import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inv1ViolationsFrom, runInv1Check } from "../src/validate/inv1/check.js";
import { loadInv1Config } from "../src/validate/inv1/config.js";
import type { Inv1Config } from "../src/validate/inv1/config.js";
import { scanFileForGuardedWrites } from "../src/validate/inv1/scan.js";

const CONFIG: Inv1Config = {
  guardedTables: {
    sessions: { columns: ["status"], allowlist: ["packages/control-plane"] },
    runs: { columns: ["status"], allowlist: ["packages/control-plane"] },
  },
  aliases: { sessionsTable: "sessions" },
  unanalyzableExceptions: ["packages/db"],
};

const scan = (path: string, content: string) => scanFileForGuardedWrites(path, content, CONFIG);

describe("scanFileForGuardedWrites — pure INV-1 primitive", () => {
  it("flags a guarded-column write outside the allowlist as a violation (negative control, acceptance b)", () => {
    const pts = scan(
      "apps/web/lib/rogue.ts",
      `export async function rogue(db) { await db.update(sessions).set({ status: "ready" }).where(x); }`,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("violation");
    expect(pts[0]?.table).toBe("sessions");
    expect(pts[0]?.columns).toEqual(["status"]);
  });

  it("allows the same guarded-column write when the file is under the allowlist", () => {
    const pts = scan(
      "packages/control-plane/src/session-startup.ts",
      `await db.update(sessions).set({ status: "ready" }).where(x);`,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("allowed");
  });

  it("ignores a write that touches only NON-guarded columns of a guarded table (column precision)", () => {
    const pts = scan(
      "apps/web/lib/touch.ts",
      "await db.update(runs).set({ sessionId, updatedAt: new Date() }).where(x);",
    );
    expect(pts).toEqual([]); // sessionId/updatedAt are not guarded → not an INV-1 concern
  });

  it("flags an opaque .set(variable) to a guarded table outside the allowlist as unanalyzable (acceptance c)", () => {
    const pts = scan("apps/web/lib/opaque.ts", "await db.update(sessions).set(updates).where(x);");
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("unanalyzable");
    expect(pts[0]?.columns).toBe("opaque");
  });

  it("treats a .set({...}) containing a spread as opaque (a spread may hide a guarded column)", () => {
    const pts = scan(
      "apps/web/lib/spread.ts",
      "await db.update(sessions).set({ idempotencyScope: x, ...(cond ? { metadata: y } : {}) }).where(z);",
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("unanalyzable");
  });

  it("allows an opaque .set inside the allowlist (canonical writer may write anything)", () => {
    const pts = scan("packages/control-plane/src/x.ts", "await db.update(runs).set(updates);");
    expect(pts[0]?.verdict).toBe("allowed");
  });

  it("resolves an aliased table identifier via config.aliases", () => {
    const pts = scan(
      "apps/web/lib/alias.ts",
      `import { sessions as sessionsTable } from "@example/db"; await db.update(sessionsTable).set({ status: "x" });`,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("violation");
    expect(pts[0]?.table).toBe("sessions");
  });

  it("ignores a non-drizzle lookalike hash.update(x).digest() (no .set in the chain)", () => {
    const pts = scan(
      "apps/web/lib/hash.ts",
      `const h = createHash("sha256").update(canonicalJson(value)).digest("hex");`,
    );
    expect(pts).toEqual([]);
  });

  it("ignores update() on a non-guarded table", () => {
    const pts = scan("apps/web/lib/other.ts", `await db.update(webhooks).set({ status: "x" });`);
    expect(pts).toEqual([]);
  });

  it("surfaces a dynamic-table update().set() outside allowlist+exceptions as unanalyzable", () => {
    const pts = scan("apps/web/lib/generic.ts", "await db.update(target.table).set(patch);");
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("unanalyzable");
    expect(pts[0]?.table).toBeNull();
  });

  it("does NOT surface a dynamic-table write inside a registered exception path (packages/db generic)", () => {
    const pts = scan(
      "packages/db/src/generic-repo.ts",
      "await db.update(target.table).set(patch);",
    );
    expect(pts).toEqual([]);
  });

  it("classifies an onConflictDoUpdate upsert to a guarded table (upsert IS a transition, not a silent miss)", () => {
    const outside = scan(
      "apps/web/lib/upsert.ts",
      'await db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.id, set: { status: "ready" } });',
    );
    expect(outside).toHaveLength(1);
    expect(outside[0]?.verdict).toBe("violation");
    const inside = scan(
      "packages/control-plane/src/x.ts",
      "await db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.id, set: updates });",
    );
    expect(inside[0]?.verdict).toBe("allowed"); // opaque set, but in allowlist
  });

  it("resolves a file-local `const X = runs` alias (closes the local-alias gap without noise)", () => {
    const pts = scan(
      "apps/web/lib/localalias.ts",
      'const t = runs; await db.update(t).set({ status: "failed" });',
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]?.verdict).toBe("violation");
    expect(pts[0]?.table).toBe("runs");
  });

  it("is a pure function: identical inputs give identical output and touch no filesystem", () => {
    const content = `await db.update(sessions).set({ status: "x" });`;
    const a = scan("apps/x.ts", content);
    const b = scan("apps/x.ts", content);
    expect(a).toEqual(b);
  });
});

describe("loadInv1Config", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codeontic-inv1cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} (skip) when no config file is present", async () => {
    expect(await loadInv1Config(dir)).toEqual({});
  });

  it("loads and validates a well-formed config", async () => {
    await mkdir(join(dir, ".codeontic"), { recursive: true });
    await writeFile(
      join(dir, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/x"] } },
      }),
    );
    const { config, error } = await loadInv1Config(dir);
    expect(error).toBeUndefined();
    expect(config?.guardedTables.runs?.columns).toEqual(["status"]);
    expect(config?.aliases).toEqual({}); // defaulted
  });

  it("returns a loud error for malformed JSON, not a silent skip", async () => {
    await mkdir(join(dir, ".codeontic"), { recursive: true });
    await writeFile(join(dir, ".codeontic", "config.json"), "{ not json");
    const { config, error } = await loadInv1Config(dir);
    expect(config).toBeUndefined();
    expect(error).toMatch(/not valid JSON/);
  });

  it("returns a loud error for schema-invalid config", async () => {
    await mkdir(join(dir, ".codeontic"), { recursive: true });
    await writeFile(
      join(dir, ".codeontic", "config.json"),
      JSON.stringify({ guardedTables: { runs: { columns: [] } } }), // empty columns + missing allowlist
    );
    const { error } = await loadInv1Config(dir);
    expect(error).toMatch(/failed schema validation/);
  });
});

describe("runInv1Check + inv1ViolationsFrom — end-to-end over a git fixture", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-inv1-repo-"));
    // git grep searches tracked files, so init + add the fixture.
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "packages", "control-plane", "src"), { recursive: true });
    await mkdir(join(repo, "apps", "hub"), { recursive: true });
    await writeFile(
      join(repo, "packages", "control-plane", "src", "ok.ts"),
      `await db.update(runs).set({ status: "completed" });`,
    );
    await writeFile(
      join(repo, "apps", "hub", "rogue.ts"),
      `await db.update(runs).set({ status: "failed" });`,
    );
    await writeFile(join(repo, "apps", "hub", "unrelated.ts"), "const x = 1; // no db writes here");
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("git-grep pre-filters candidates, scans them, and finds exactly the out-of-allowlist violation", async () => {
    const config: Inv1Config = {
      guardedTables: { runs: { columns: ["status"], allowlist: ["packages/control-plane"] } },
      aliases: {},
      unanalyzableExceptions: [],
    };
    const result = await runInv1Check(repo, config);
    expect(result.ran).toBe(true);
    expect(result.candidateFiles).toBe(2); // the two files with .update( — not unrelated.ts
    const violations = result.writePoints.filter((w) => w.verdict === "violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.filePath).toBe("apps/hub/rogue.ts");
    const allowed = result.writePoints.filter((w) => w.verdict === "allowed");
    expect(allowed[0]?.filePath).toBe("packages/control-plane/src/ok.ts");
    expect(result.timingMs).toBeGreaterThanOrEqual(0);
  });

  it("maps verdicts to T0 severities: violation→error, unanalyzable→warning, allowed→omitted", async () => {
    const config: Inv1Config = {
      guardedTables: { runs: { columns: ["status"], allowlist: ["packages/control-plane"] } },
      aliases: {},
      unanalyzableExceptions: [],
    };
    const result = await runInv1Check(repo, config);
    const vs = inv1ViolationsFrom(result);
    expect(vs.every((v) => v.check === "inv1-write-site")).toBe(true);
    expect(vs.filter((v) => v.severity === "error")).toHaveLength(1); // the rogue violation
    expect(vs.some((v) => v.message.includes("allowed"))).toBe(false); // allowed points are not violations
  });

  it("reports a loud skip (not a silent pass) when run against a non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "codeontic-nongit-"));
    try {
      const config: Inv1Config = {
        guardedTables: { runs: { columns: ["status"], allowlist: ["x"] } },
        aliases: {},
        unanalyzableExceptions: [],
      };
      const result = await runInv1Check(nonGit, config);
      expect(result.ran).toBe(false);
      expect(result.skippedReason).toMatch(/git/);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});
