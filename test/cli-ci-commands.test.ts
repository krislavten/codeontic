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

  it("a boolean flag does not swallow the next argument", async () => {
    // `--strict-anchors <dir>` used to eat the directory: positionals went
    // empty (so the target fell back to cwd — a different tree than the caller
    // named) AND `--strict-anchors` stopped being `true` (so strict mode
    // silently did not happen). Both loosen the check, and it still exited 0.
    await rm(join(repo, "src", "synth", "main.ts"));
    const code = await run(["gate", "--repo-root", repo, "--strict-anchors", repo], io);
    expect(code).toBe(1); // strict really is on, and the target really is `repo`
    const text = out.join("\n");
    expect(text).toContain("anchor-existence");
  });

  it("--model-only --base does a narrow comparison instead of failing outright", async () => {
    // This combination used to be accepted by the CLI and then rejected inside
    // the gate, so it ALWAYS exited 1 — even on a model with zero errors, with
    // a message that never mentioned --model-only. The two things it can answer
    // (did this change introduce a model error, did the debt grow) need no repo
    // scan at all.
    await git("tag", "basepoint");
    const code = await run(["gate", repo, "--model-only", "--base", "basepoint"], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("model-only");
    expect(text).not.toContain("unverifiable");
  });

  it("--model-only --base still catches a model error this change introduced", async () => {
    await git("tag", "basepoint");
    await writeFile(
      join(repo, ".codeontic", "model", "loops", "dup.yaml"),
      '- id: L90\n  kind: loop\n  title: 重复 id\n  boundary: "a → b"\n  owner: null\n  dormant: true\n',
    );
    const code = await run(["gate", repo, "--model-only", "--base", "basepoint"], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("introduced by this change");
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

  it("a broken anchor without --strict-anchors passes, but the summary does not claim consistency", async () => {
    // anchor-existence is advisory by default (an engine-level decision). The
    // gate honouring that is fine; printing "模型与代码一致，没有 error" while
    // the model points at a deleted file is not — it teaches people the gate is
    // wrong, which costs more than the leniency.
    await rm(join(repo, "src", "synth", "main.ts"));
    const code = await run(["gate", repo, "--repo-root", repo, "--format", "github"], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("✅ 模型与代码一致，没有 error。");
    expect(text).toContain("advisory");
    expect(text).toContain("--strict-anchors");
  });

  it("an unscorable base AND advisory findings both get said — one caveat must not hide the other", async () => {
    // Shallow-clone CI (no merge-base) plus a model pointing at a deleted file:
    // an earlier shape returned early on the base caveat and dropped the
    // advisory one, so the summary mentioned exactly one of the two things that
    // had not been checked.
    await rm(join(repo, "src", "synth", "main.ts"));
    const code = await run(
      [
        "gate",
        repo,
        "--repo-root",
        repo,
        "--base",
        "refs/heads/does-not-exist",
        "--format",
        "github",
      ],
      io,
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("advisory");
    expect(text).toContain("基线没能打分");
    expect(text).not.toContain("✅ 模型与代码一致，没有 error。");
  });

  it("RELATIVE paths on the command line still compare correctly", async () => {
    // `gate . --repo-root . --base main` is how a workflow actually writes it.
    // The comparison redacts the roots out of messages; with "." treated as a
    // root, every "." in every message was replaced on the HEAD side only —
    // `src/main.ts#Loop` → `src/main<root>ts#Loop` — so no key ever matched and
    // every error already on the trunk read as introduced by the PR.
    await breakAnchor();
    await git("add", "-A");
    await git("commit", "-qm", "broken at base");
    await git("tag", "basepoint");
    // An unrelated commit on top: this PR introduces nothing.
    await writeFile(join(repo, "unrelated.txt"), "hello\n");
    await git("add", "-A");
    await git("commit", "-qm", "unrelated change");

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const code = await run(
        ["gate", ".", "--repo-root", ".", "--base", "basepoint", "--strict-anchors"],
        io,
      );
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("already present at the base ref");
      // And the messages must not have been mangled by the redaction.
      expect(text).not.toContain("<root>ts");
    } finally {
      process.chdir(cwd);
    }
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

  it("without --base the verdict does NOT claim the change introduced anything", async () => {
    // `new-errors` names a comparison result. With no base there was no
    // comparison: every error at HEAD is reported, old ones included, and
    // "introduced by this change" would point the author at code they never
    // touched.
    await breakAnchor();
    const code = await run(["gate", repo, "--repo-root", repo, "--strict-anchors"], io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).not.toContain("introduced by this change");
    expect(text).toContain("No --base");
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

  it("a PRE-EXISTING INV-1 violation does not fail a PR that merely touches the file", async () => {
    // The attribution the worktree replaced: "was the file touched?" blamed a
    // one-line import edit for a violation that had been sitting on the trunk.
    // Now both sides scan, and the finding is identical on both.
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
      }),
    );
    await mkdir(join(repo, "packages", "rogue"), { recursive: true });
    const writer = join(repo, "packages", "rogue", "writer.ts");
    await writeFile(
      writer,
      "import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n  await db.update(runs).set({ status: 'done' });\n}\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "trunk already has the violation");
    await git("tag", "basepoint");

    // This change only adds an unrelated import to that same file.
    await writeFile(writer, `import './unrelated';\n${await readFile(writer, "utf8")}`);
    await git("add", "-A");
    await git("commit", "-qm", "touch the file, introduce nothing");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    const text = out.join("\n");
    expect(text).toContain("inv1-write-site"); // still REPORTED…
    expect(code).toBe(0); // …but not blamed on this change
    expect(text).toContain("already present at the base ref");
  });

  it("an INV-1 violation this change really introduces still fails", async () => {
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
      }),
    );
    await git("add", "-A");
    await git("commit", "-qm", "config only");
    await git("tag", "basepoint");

    await mkdir(join(repo, "packages", "rogue"), { recursive: true });
    await writeFile(
      join(repo, "packages", "rogue", "writer.ts"),
      "import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n  await db.update(runs).set({ status: 'done' });\n}\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "introduce the violation");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("introduced by this change");
  });

  it("a './'-prefixed anchor path is resolved the same way on both sides", async () => {
    // The asymmetry the worktree removed: the base side answered existence from
    // `git ls-tree` (exact tree paths) while HEAD used `stat` (which normalises
    // `./x`). An anchor written that way was "missing at base" and "present at
    // HEAD" forever; delete its file here and both sides said "does not exist",
    // the keys matched, and a real regression scored as pre-existing.
    const model = join(repo, ".codeontic", "model", "loops", "main.yaml");
    await writeFile(
      model,
      (await readFile(model, "utf8")).replace(
        'anchors: ["src/synth/main.ts#SynthLoop"]',
        'anchors: ["./src/synth/main.ts#SynthLoop"]',
      ),
    );
    await git("add", "-A");
    await git("commit", "-qm", "dot-slash anchor");
    await git("tag", "basepoint");

    // Base is clean (the file is there, under either spelling). This change
    // deletes it — that is a regression and must be attributed here.
    await rm(join(repo, "src", "synth", "main.ts"));
    await git("add", "-A");
    await git("commit", "-qm", "delete the anchored file");

    const code = await run(
      ["gate", repo, "--repo-root", repo, "--base", "basepoint", "--strict-anchors"],
      io,
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("introduced by this change");
  });

  it("a subdirectory --repo-root is mapped into the base worktree, not flattened to its root", async () => {
    // The base side is a whole checkout; --repo-root may point into it. Scoring
    // the worktree ROOT against a subdirectory HEAD makes every anchor "missing
    // at base" too, so a file this change really deleted compares equal and is
    // waved through as pre-existing.
    const svc = join(repo, "services", "api");
    // Mirror the fixture's OTHER anchor targets under the service root too, so
    // the only difference between the two sides is the file this change
    // deletes. Without this the test passes for the wrong reason: the unrelated
    // anchors resolve differently under the two roots and produce "new" errors
    // of their own, which would keep it green even with the mapping removed.
    await mkdir(join(svc, "src", "synth"), { recursive: true });
    await mkdir(join(svc, "test", "synth"), { recursive: true });
    await mkdir(join(svc, "docs"), { recursive: true });
    for (const f of ["main.ts", "dormant.ts"]) {
      await writeFile(
        join(svc, "src", "synth", f),
        "export const SynthLoop = { subphase: 1 };\nexport const SynthDormant = 1;\n",
      );
    }
    await writeFile(join(svc, "test", "synth", "handoff.test.ts"), "// synth handoff\n");
    await writeFile(join(svc, "docs", "synth-spec.md"), "# handoff_contract\n");
    await writeFile(join(svc, "src", "handler.ts"), "export const Handler = 1;\n");
    const model = join(repo, ".codeontic", "model", "loops", "main.yaml");
    await writeFile(
      model,
      (await readFile(model, "utf8")).replace(
        'anchors: ["src/synth/main.ts#SynthLoop"]',
        'anchors: ["src/handler.ts#Handler"]',
      ),
    );
    await git("add", "-A");
    await git("commit", "-qm", "service with its own anchored file");
    await git("tag", "basepoint");

    // Base is clean under repoRoot=svc. This change deletes the anchored file.
    await rm(join(svc, "src", "handler.ts"));
    await git("add", "-A");
    await git("commit", "-qm", "delete it");

    const code = await run(
      ["gate", repo, "--repo-root", svc, "--base", "basepoint", "--strict-anchors"],
      io,
    );
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("introduced by this change");
    // Exactly the deleted file, and nothing dragged in by a scope mismatch.
    expect(text).toContain("handler.ts");
    expect(text).toContain("1 error(s) introduced");
  });

  it("a model that lives in a subdirectory is loaded from the same subdirectory at base", async () => {
    // targetDir and repoRoot are mapped independently; this covers the target
    // one. Flattened to the worktree root, the base side finds no model there
    // and the run degrades into an error about a missing model — which is not
    // the same thing as "this change broke an anchor".
    const svc = join(repo, "services", "api");
    await mkdir(join(svc, "src"), { recursive: true });
    await writeFile(join(svc, "src", "handler.ts"), "export const Handler = 1;\n");
    // The model moves WITH the service.
    await mkdir(join(svc, ".codeontic"), { recursive: true });
    await exec("cp", ["-R", join(repo, ".codeontic", "model"), join(svc, ".codeontic", "model")]);
    await rm(join(repo, ".codeontic"), { recursive: true, force: true });
    const model = join(svc, ".codeontic", "model", "loops", "main.yaml");
    await writeFile(
      model,
      (await readFile(model, "utf8")).replace(
        'anchors: ["src/synth/main.ts#SynthLoop"]',
        'anchors: ["src/handler.ts#Handler"]',
      ),
    );
    // Same de-confounding as above: every other anchor must resolve on both
    // sides, so the deleted file is the only difference.
    await mkdir(join(svc, "src", "synth"), { recursive: true });
    await mkdir(join(svc, "test", "synth"), { recursive: true });
    await mkdir(join(svc, "docs"), { recursive: true });
    for (const f of ["main.ts", "dormant.ts"]) {
      await writeFile(
        join(svc, "src", "synth", f),
        "export const SynthLoop = { subphase: 1 };\nexport const SynthDormant = 1;\n",
      );
    }
    await writeFile(join(svc, "test", "synth", "handoff.test.ts"), "// synth handoff\n");
    await writeFile(join(svc, "docs", "synth-spec.md"), "# handoff_contract\n");
    await git("add", "-A");
    await git("commit", "-qm", "model lives with the service");
    await git("tag", "basepoint");

    await rm(join(svc, "src", "handler.ts"));
    await git("add", "-A");
    await git("commit", "-qm", "delete the anchored file");

    const code = await run(
      ["gate", svc, "--repo-root", svc, "--base", "basepoint", "--strict-anchors"],
      io,
    );
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("1 error(s) introduced");
    expect(text).toContain("handler.ts");
    // Not the degraded "no model at base" path.
    expect(text).not.toContain('run "codeontic init"');
  });

  it("a base ref from before the model existed fails closed, with an honest reason", async () => {
    // Real case: a base older than the directory rename. `loadModel` throws on
    // the base side, and letting that escape crashed the gate with "run
    // codeontic init" — a message about the temp worktree that reads as a
    // message about the user's checkout.
    await rm(join(repo, ".codeontic"), { recursive: true, force: true });
    await git("add", "-A");
    await git("commit", "-qm", "before the model existed");
    await git("tag", "prehistory");
    await seedSyntheticModel(repo);
    await breakAnchor();
    await git("add", "-A");
    await git("commit", "-qm", "add the model, with a broken anchor");

    const code = await run(
      ["gate", repo, "--repo-root", repo, "--base", "prehistory", "--strict-anchors"],
      io,
    );
    const text = out.join("\n");
    expect(code).toBe(1);
    // Fails CLOSED and says the BASE could not be scored…
    expect(text).toContain("base");
    // …not a bare crash telling the author to initialise their repo.
    expect(text).not.toMatch(/^model directory .* is not found/m);
  });

  it("a clean HEAD with an unscorable base passes, but SAYS the base was not scored", async () => {
    // Passing is right (nothing is wrong at HEAD), staying quiet is not: debt
    // growth needs both sides, so one check genuinely did not run.
    await rm(join(repo, ".codeontic"), { recursive: true, force: true });
    await git("add", "-A");
    await git("commit", "-qm", "before the model existed");
    await git("tag", "prehistory");
    await seedSyntheticModel(repo);
    await git("add", "-A");
    await git("commit", "-qm", "add a clean model");

    const code = await run(
      ["gate", repo, "--repo-root", repo, "--base", "prehistory", "--strict-anchors"],
      io,
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    // The base caveat is now ADDITIVE (it used to replace the others), so it
    // reads as "另外：基线没能打分…" rather than as the whole verdict.
    expect(text).toContain("基线没能打分");
    expect(text).toContain("没查");
  });

  it("INV-1 configured but unable to scan fails the gate — zero findings is not 'no problems'", async () => {
    // Config present, but the scan needs `git grep`. A source tree without a
    // git dir (copied into a Docker image, say) yields zero write points, which
    // is indistinguishable from a clean scan unless `ran` is checked. `check`
    // prints a loud "INV-1 scan skipped"; the gate must not be quieter.
    const copy = await mkdtemp(join(tmpdir(), "codeontic-nogit-"));
    try {
      await exec("cp", ["-R", `${repo}/.codeontic`, `${copy}/.codeontic`]);
      await mkdir(join(copy, "src", "synth"), { recursive: true });
      await writeFile(
        join(copy, ".codeontic", "config.json"),
        JSON.stringify({
          guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
        }),
      );
      const logs: string[] = [];
      const code = await run(["gate", copy, "--repo-root", copy], {
        log: (l) => logs.push(l),
        error: (l) => logs.push(l),
      });
      const text = logs.join("\n");
      expect(text).not.toContain("✅ 模型与代码一致，没有 error。");
      expect(code).toBe(1);
      expect(text).toContain("INV-1 did not run");
      // The config here is perfectly valid — the guidance must not send the
      // author to go fix its JSON syntax.
      expect(text).not.toContain("JSON 语法");
      expect(text).toContain("没能启动");
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it("a SECOND identical INV-1 write site in one file is still judged new", async () => {
    // The snippet is normalised source text, so two textually identical write
    // statements collapse to one identity unless an ordinal distinguishes them
    // — base has one, the PR adds another, both match, and a genuinely new
    // violation is waved through as pre-existing.
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
      }),
    );
    await mkdir(join(repo, "packages", "rogue"), { recursive: true });
    const writer = join(repo, "packages", "rogue", "writer.ts");
    const stmt = "  await db.update(runs).set({ status: 'done' });\n";
    await writeFile(
      writer,
      `import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n${stmt}}\n`,
    );
    await git("add", "-A");
    await git("commit", "-qm", "one violation on the trunk");
    await git("tag", "basepoint");

    // Add a SECOND, textually identical write statement.
    await writeFile(
      writer,
      `import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n${stmt}}\nexport async function g() {\n${stmt}}\n`,
    );
    await git("add", "-A");
    await git("commit", "-qm", "add an identical second one");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("introduced by this change");
  });

  it("a new debt node is told to pay the debt, not to fix a nonexistent schema error", async () => {
    await writeFile(
      join(repo, ".codeontic", "model", "baseline", "DEBT-SL-new.yaml"),
      [
        "id: DEBT-SL-new",
        "kind: debt",
        "category: dead_state_machine",
        "subject: 新增债务",
        'reality: "x"',
        'owner: "packages/synth-owner"',
        'removal_condition: "y"',
        "",
      ].join("\n"),
    );
    await git("add", "-A");
    await git("commit", "-qm", "register new debt");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "HEAD~1"], io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("新增了债务节点");
    expect(text).not.toContain("按上面每条的 message 修模型");
  });

  it("an INV-1 violation is told to fix the write site, not the model", async () => {
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
      }),
    );
    await git("add", "-A");
    await git("commit", "-qm", "config");
    await mkdir(join(repo, "packages", "rogue"), { recursive: true });
    await writeFile(
      join(repo, "packages", "rogue", "writer.ts"),
      "import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n  await db.update(runs).set({ status: 'done' });\n}\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "rogue write");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "HEAD~1"], io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("规范写点");
    expect(text).not.toContain("按上面每条的 message 修模型");
  });

  it("DELETING .codeontic/config.json fails the gate — turning a check off is a regression", async () => {
    // The nastiest shape of "nothing was checked reads as clean": the trunk has
    // INV-1 violations, the PR removes the config, HEAD reports zero findings,
    // the base's violations look fixed, and INV-1 is off for every future PR.
    await writeFile(
      join(repo, ".codeontic", "config.json"),
      JSON.stringify({
        guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
      }),
    );
    await mkdir(join(repo, "packages", "rogue"), { recursive: true });
    await writeFile(
      join(repo, "packages", "rogue", "writer.ts"),
      "import { db } from './db';\nimport { runs } from './schema';\nexport async function f() {\n  await db.update(runs).set({ status: 'done' });\n}\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "trunk: config present, one violation");
    await git("tag", "basepoint");

    await rm(join(repo, ".codeontic", "config.json"));
    await git("add", "-A");
    await git("commit", "-qm", "delete the config");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("INV-1 ran at the base ref but not here");
    expect(text).not.toContain("gate: passed");
  });

  it("a coverage regression is told to restore what was removed, not to fix YAML/JSON", async () => {
    await git("tag", "basepoint");
    const modelDir = join(repo, ".codeontic", "model");
    for (const sub of ["loops", "flows", "junctions", "scenarios", "features", "baseline"]) {
      await rm(join(modelDir, sub), { recursive: true, force: true });
    }
    await mkdir(modelDir, { recursive: true });
    await git("add", "-A");
    await git("commit", "-qm", "empty the model");

    await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    const text = out.join("\n");
    expect(text).toContain("整个去掉了");
    // Not the two buckets it used to borrow.
    expect(text).not.toContain("按上面每条的 message 修模型");
    expect(text).not.toContain("JSON 语法");
  });

  it("a config that was ALREADY broken on the trunk is not described as 'it ran there'", async () => {
    // The wording has to follow the base state. Telling an author to restore a
    // config so INV-1 runs again is wrong when that config was malformed on the
    // trunk and the layer had never started — and deleting it still must fail,
    // because it makes the missing check permanent and silent.
    await writeFile(join(repo, ".codeontic", "config.json"), "{ not json at all");
    await git("add", "-A");
    await git("commit", "-qm", "trunk carries a broken config");
    await git("tag", "basepoint");

    await rm(join(repo, ".codeontic", "config.json"));
    await git("add", "-A");
    await git("commit", "-qm", "delete the broken config");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("malformed");
    expect(text).not.toContain("INV-1 ran at the base ref");
  });

  it("a base where the SCAN could not start is not described as 'INV-1 ran there'", async () => {
    // Config valid on both sides, but the base has no git checkout for the scan
    // to use. Writing coverage.inv1 = "ran" just because runInv1Check was called
    // put back the misattribution the three-state type exists to prevent.
    const { runCheck } = await import("../src/cli/commands/check.js");
    const nogit = await mkdtemp(join(tmpdir(), "codeontic-nogit-"));
    try {
      await exec("cp", ["-R", `${repo}/.codeontic`, `${nogit}/.codeontic`]);
      await writeFile(
        join(nogit, ".codeontic", "config.json"),
        JSON.stringify({
          guardedTables: { runs: { columns: ["status"], allowlist: ["packages/canonical"] } },
        }),
      );
      const result = await runCheck(nogit, { repoRoot: nogit });
      // The scan could not start here, so this must NOT read as "ran".
      expect(result.inv1?.ran).toBe(false);
      expect(result.coverage.inv1).toBe("scan-unavailable");
    } finally {
      await rm(nogit, { recursive: true, force: true });
    }
  });

  it("emptying the model directory fails the gate — vacuous checks are not passing checks", async () => {
    await git("tag", "basepoint");
    const modelDir = join(repo, ".codeontic", "model");
    for (const sub of ["loops", "flows", "junctions", "scenarios", "features", "baseline"]) {
      await rm(join(modelDir, sub), { recursive: true, force: true });
    }
    await mkdir(modelDir, { recursive: true });
    await git("add", "-A");
    await git("commit", "-qm", "empty the model, keep the directory");

    const code = await run(["gate", repo, "--repo-root", repo, "--base", "basepoint"], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("has none here");
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
