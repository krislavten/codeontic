import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli/run.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

/**
 * The CI commands as a WORKFLOW ACTUALLY INVOKES THEM: through `run(argv)`,
 * with argv strings, not by calling the engine functions with typed options.
 *
 * This file exists because three separate defects lived exactly in that gap and
 * all of them survived a suite that tested `runGate` directly:
 *  - `--repo-root ""` never arrived as `undefined`, because `path.resolve("")`
 *    is the current working directory — so the "you must pass --repo-root"
 *    guard could not fire on the real command line, only in the unit test;
 *  - `--base ""` arrived as a falsy string, skipping both that guard and the
 *    baseline comparison, and every pre-existing error read as newly introduced;
 *  - the gate never passed a diff base down to `check`, so two checks silently
 *    never ran — invisible unless you compare `gate` and `check` end to end.
 *
 * Empty-string flags are the CI-native failure: `--base "${{ env.BASE }}"` with
 * an unset variable produces exactly that, and it looks like a normal argv.
 */

const exec = promisify(execFile);

let repo: string;
let out: string[];

const io = {
  log: (l: string) => out.push(l),
  error: (l: string) => out.push(l),
};

async function git(...args: string[]) {
  await exec("git", args, { cwd: repo });
}

beforeEach(async () => {
  out = [];
  repo = await mkdtemp(join(tmpdir(), "codeontic-cli-"));
  await seedSyntheticModel(repo);
  await mkdir(join(repo, "src", "synth"), { recursive: true });
  await mkdir(join(repo, "test", "synth"), { recursive: true });
  for (const f of ["main.ts", "dormant.ts"]) {
    await writeFile(
      join(repo, "src", "synth", f),
      "export const SynthLoop = { subphase: 1 };\nexport const SynthDormant = 1;\n",
    );
  }
  await writeFile(join(repo, "test", "synth", "handoff.test.ts"), "// synth handoff\n");
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs", "synth-spec.md"), "# handoff_contract\n");
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await git("add", "-A");
  await git("commit", "-qm", "base");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function breakAnchor() {
  const path = join(repo, ".codeontic", "model", "loops", "main.yaml");
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace(".ts#", "-GONE.ts#"));
}

/**
 * Restores `$GITHUB_STEP_SUMMARY`. Deletes via Reflect rather than assigning
 * `undefined`: `process.env.X = undefined` stores the STRING "undefined", which
 * would leave later tests pointing at a file named `undefined`.
 */
function restoreSummaryEnv(previous: string | undefined) {
  if (previous === undefined) Reflect.deleteProperty(process.env, "GITHUB_STEP_SUMMARY");
  else process.env.GITHUB_STEP_SUMMARY = previous;
}

describe("gate — argv-level", () => {
  it("a clean repo exits 0", async () => {
    const code = await run(["gate", repo, "--repo-root", repo, "--strict-anchors"], io);
    expect(code).toBe(0);
  });

  it('--repo-root "" is refused, not silently resolved to the current directory', async () => {
    await breakAnchor();
    const code = await run(
      ["gate", repo, "--repo-root", "", "--base", "main", "--strict-anchors"],
      io,
    );
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("--repo-root");
    expect(text).toContain("empty value");
    // It must NOT have gone on to score anything against the cwd.
    expect(text).not.toContain("gate: passed");
  });

  it('--base "" is refused, not treated as "no baseline"', async () => {
    // The dangerous reading: falsy → skip the comparison → every error on the
    // trunk gets reported as introduced by this change.
    await breakAnchor();
    const code = await run(
      ["gate", repo, "--repo-root", repo, "--base", "", "--strict-anchors"],
      io,
    );
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("--base");
    expect(text).toContain("empty value");
    expect(text).not.toContain("introduced by this change");
  });

  it("gate without --repo-root is refused — a half-run must not read as a pass", async () => {
    // The model alone is clean here, so the partial run would have printed
    // "gate: passed — no model errors" and exited 0 while anchor-existence and
    // INV-1 never executed.
    const code = await run(["gate", repo], io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("--repo-root");
    expect(text).not.toContain("passed");
  });

  it("--model-only allows the partial run but says so in the verdict", async () => {
    const code = await run(["gate", repo, "--model-only", "--format", "github"], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("model-only");
    // The summary must not make the full-run claim…
    expect(text).not.toContain("✅ 模型与代码一致，没有 error。");
    // …and must name what did not run.
    expect(text).toContain("没跑");
  });

  it("an error already on the trunk exits 0 through the real command line", async () => {
    await breakAnchor();
    await git("add", "-A");
    await git("commit", "-qm", "broken at base");
    const code = await run(
      ["gate", repo, "--repo-root", repo, "--base", "HEAD", "--strict-anchors"],
      io,
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("already present at the base ref");
  });

  it("an error introduced by the change exits 1 through the real command line", async () => {
    await breakAnchor();
    const code = await run(
      ["gate", repo, "--repo-root", repo, "--base", "HEAD", "--strict-anchors"],
      io,
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("introduced by this change");
  });
});

describe("gate vs check — no check may be lost in the move", () => {
  /**
   * A repo whose CI switches from `check` to `gate` must not lose enforcement.
   * `baseline-growth` is the case that made this concrete: deleting a debt node
   * fails `check --diff`, and `gate --base` reported nothing because it never
   * passed the base down.
   */
  it("ADDING a debt node fails BOTH check --diff and gate --base", async () => {
    // The check is "baseline only DECREASES": removing debt is the goal, adding
    // it is the violation. (Written the other way round first — the test then
    // asserted that a legitimate action fails, and only survived because the
    // engine correctly said nothing.)
    await writeFile(
      join(repo, ".codeontic", "model", "baseline", "DEBT-SL-new.yaml"),
      [
        "id: DEBT-SL-new",
        "kind: debt",
        "category: dead_state_machine",
        "subject: 本次新增的债务",
        'reality: "新增，用于验证 baseline 只减不增"',
        'owner: "packages/synth-owner"',
        'removal_condition: "验证完删除"',
        "",
      ].join("\n"),
    );

    const checkOut: string[] = [];
    const checkCode = await run(["check", repo, "--repo-root", repo, "--diff", "HEAD"], {
      log: (l) => checkOut.push(l),
      error: (l) => checkOut.push(l),
    });
    const gateCode = await run(["gate", repo, "--repo-root", repo, "--base", "HEAD"], io);

    // `check` must actually be angry, otherwise this asserts nothing.
    expect(checkCode).not.toBe(0);
    expect(checkOut.join("\n")).toContain("baseline");
    // …and `gate` must reach the same verdict, for the same reason.
    expect(gateCode).toBe(1);
    expect(out.join("\n")).toContain("baseline");
  });

  it("a subdirectory --repo-root still scans INV-1 (paths speak the same base)", async () => {
    // `git diff --name-only` returns GIT-TOP-LEVEL paths whichever directory it
    // runs in, while INV-1's `git grep` candidates are repoRoot-relative. With a
    // subdirectory repo root the intersection used to be empty, so INV-1 scanned
    // zero files and the gate went green on a violation sitting right there.
    const svc = join(repo, "services", "api");
    await mkdir(join(svc, "packages", "rogue"), { recursive: true });
    // The config is read from the TARGET dir (where the model lives), while the
    // allowlist paths are relative to --repo-root.
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
      }),
    );
    await git("add", "-A");
    await git("commit", "-qm", "service scaffold");
    await git("tag", "svcbase");

    await writeFile(
      join(svc, "packages", "rogue", "writer.ts"),
      "import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n  await db.update(runs).set({ status: 'done' });\n}\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "rogue write inside the service");

    const checkOut: string[] = [];
    await run(["check", repo, "--repo-root", svc, "--diff", "svcbase"], {
      log: (l) => checkOut.push(l),
      error: (l) => checkOut.push(l),
    });
    const text = checkOut.join("\n");
    // The scan must have actually looked at the file (0 scanned = the old bug).
    expect(text).toMatch(/INV-1 scan: [1-9]\d*\//);
    expect(text).toContain("violation");
  });

  it("an INV-1 write-site violation fails gate too, not only check", async () => {
    // 0.13.0 dropped INV-1 from the gate wholesale (the base side cannot score
    // an AST scan), so a repo moving its CI from `check` to `gate` lost the
    // enforcement without a word. With a diff base, INV-1 scans only the touched
    // files — which is exactly what makes the finding attributable.
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify(
        {
          guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
          aliases: {},
          unanalyzableExceptions: [],
        },
        null,
        2,
      ),
    );
    await git("add", "-A");
    await git("commit", "-qm", "add inv1 config");
    await git("tag", "basepoint");

    // A write to the guarded column from outside the allowlist — COMMITTED,
    // because both the diff and INV-1's `git grep` pre-filter see tracked,
    // committed state. (Left uncommitted first: the scan found nothing and the
    // test would have "passed" against a gate that enforces nothing.)
    await mkdir(join(repo, "packages", "rogue"), { recursive: true });
    await writeFile(
      join(repo, "packages", "rogue", "writer.ts"),
      "import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n  await db.update(runs).set({ status: 'done' });\n}\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "rogue write site");

    const checkOut: string[] = [];
    const checkCode = await run(["check", repo, "--repo-root", repo, "--diff", "basepoint"], {
      log: (l) => checkOut.push(l),
      error: (l) => checkOut.push(l),
    });
    const gateCode = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);

    // If this environment cannot run the scan at all, the test asserts nothing
    // useful — say so loudly rather than passing quietly.
    expect(checkOut.join("\n")).not.toContain("INV-1 scan skipped");
    expect(checkCode).toBe(1);
    expect(gateCode).toBe(1);
    expect(out.join("\n")).toContain("inv1-write-site");
  });
});

describe("report / drift-report — argv-level", () => {
  it("report exits 0 and says which section did not run", async () => {
    const code = await run(["report", repo], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("这次没查");
  });

  it("report survives an unwritable $GITHUB_STEP_SUMMARY instead of crashing", async () => {
    // A summary path that cannot be appended to (a directory) used to reject out
    // of a command documented as never failing.
    const previous = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = repo; // a directory → EISDIR on append
    try {
      const code = await run(["report", repo, "--repo-root", repo, "--format", "github"], io);
      expect(code).toBe(0);
      // Content is not lost — it falls back to stdout.
      expect(out.join("\n")).toContain("codeontic 报告档");
    } finally {
      restoreSummaryEnv(previous);
    }
  });

  it("gate survives an unwritable $GITHUB_STEP_SUMMARY and keeps its exit code", async () => {
    await breakAnchor();
    const previous = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = repo;
    try {
      const code = await run(
        ["gate", repo, "--repo-root", repo, "--strict-anchors", "--format", "github"],
        io,
      );
      expect(code).toBe(1);
      expect(out.join("\n")).toContain("判红");
    } finally {
      restoreSummaryEnv(previous);
    }
  });

  it('drift-report refuses an empty --base rather than comparing against ""', async () => {
    const code = await run(["drift-report", repo, "--repo-root", repo, "--base", ""], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("empty value");
  });
});
