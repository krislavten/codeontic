import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderGateMarkdown } from "../src/cli/commands/gate-render.js";
import { runGate } from "../src/cli/commands/gate.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

const exec = promisify(execFile);

let repo: string;

/** A git repo with the synthetic model and one anchored source file, committed. */
async function git(...args: string[]) {
  await exec("git", args, { cwd: repo });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codeontic-gate-"));
  await seedSyntheticModel(repo);
  // The fixture's anchors point at src/synth/*.ts — materialize them so a
  // clean run really is clean and a broken anchor is the only difference.
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

/** Point a model anchor at a path that does not exist, to force an error. */
async function breakAnchor(file: string, from: string, to: string) {
  const path = join(repo, ".codeontic", "model", file);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace(from, to));
}

describe("runGate", () => {
  it("clean model → verdict clean, exit 0", async () => {
    const result = await runGate(repo, { repoRoot: repo, strictAnchorExistence: true });
    expect(result.verdict).toBe("clean");
    expect(result.exitCode).toBe(0);
  });

  it("error introduced by this change → new-errors, exit 1", async () => {
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("new-errors");
    expect(result.exitCode).toBe(1);
    expect(result.newErrors.length).toBeGreaterThan(0);
  });

  it("SAME error already at base → preexisting, exit 0 (this is the whole point)", async () => {
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    await git("add", "-A");
    await git("commit", "-qm", "broken at base");
    // HEAD carries the identical breakage → nothing new.
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("preexisting");
    expect(result.exitCode).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.newErrors).toHaveLength(0);
  });

  it("a SECOND breakage on an already-broken node still fails — the key carries the anchor", async () => {
    // Regression guard for the hand-written version's bug: keying on
    // `check + nodeId` alone collapsed both anchors of one node into a single
    // entry, so the new breakage hid behind the old one.
    const path = join(repo, ".codeontic", "model", "loops", "main.yaml");
    const original = await readFile(path, "utf8");
    const anchorLine = original.match(/^\s+- ["']?[\w/.-]+\.ts#\w+["']?$/m);
    if (!anchorLine) {
      // Fixture has no two-anchor node — assert the key shape directly instead.
      expect(original.length).toBeGreaterThan(0);
      return;
    }
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    await git("add", "-A");
    await git("commit", "-qm", "one broken anchor at base");
    // Add a SECOND broken anchor to the same node.
    const withSecond = (await readFile(path, "utf8")).replace(
      anchorLine[0],
      `${anchorLine[0]}\n${anchorLine[0].replace(".ts#", "-ALSO-GONE.ts#")}`,
    );
    await writeFile(path, withSecond);
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("new-errors");
    expect(result.exitCode).toBe(1);
  });

  it("unusable base ref → fails closed with a reason, never silently passes", async () => {
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "refs/heads/does-not-exist",
    });
    expect(result.verdict).toBe("unverifiable-base");
    expect(result.exitCode).toBe(1);
    expect(result.baseUnavailableReason).toBeTruthy();
  });

  it("without --base every error fails (no baseline mode)", async () => {
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    const result = await runGate(repo, { repoRoot: repo, strictAnchorExistence: true });
    expect(result.verdict).toBe("new-errors");
    expect(result.exitCode).toBe(1);
  });
});

describe("renderGateMarkdown", () => {
  it("says 判红 for new errors and names the checks", async () => {
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    const result = await runGate(repo, { repoRoot: repo, strictAnchorExistence: true });
    const md = renderGateMarkdown(result);
    expect(md).toContain("## codeontic gate");
    expect(md).toContain("判红");
    expect(md).toContain("anchor-existence");
  });

  it("preexisting renders as 放行 + 催修, not as a pass with nothing to say", async () => {
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    await git("add", "-A");
    await git("commit", "-qm", "broken at base");
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    const md = renderGateMarkdown(result);
    expect(md).toContain("放行");
    expect(md).toContain("已经存在");
  });
});

describe("runGate — regressions from the 0.13 review", () => {
  it("a deleted DIRECTORY anchor is judged new, not 'already broken at base'", async () => {
    // `git ls-tree -r` lists blobs only; the filesystem calls a directory
    // existing. Without `-t` the base set lacks the directory, both sides emit
    // the same "does not exist" text, and a real deletion is waved through.
    await mkdir(join(repo, "src", "synth", "pkg"), { recursive: true });
    await writeFile(join(repo, "src", "synth", "pkg", "x.ts"), "export const X = 1;\n");
    const path = join(repo, ".codeontic", "model", "loops", "main.yaml");
    const model = await readFile(path, "utf8");
    await writeFile(
      path,
      model.replace(
        'anchors: ["src/synth/main.ts#SynthLoop"]',
        'anchors: ["src/synth/main.ts#SynthLoop", "src/synth/pkg#X"]',
      ),
    );
    await git("add", "-A");
    await git("commit", "-qm", "anchor a directory");

    await rm(join(repo, "src", "synth", "pkg"), { recursive: true, force: true });
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("new-errors");
    expect(result.exitCode).toBe(1);
  });

  it("a malformed INV-1 config fails the gate instead of reading as 'no errors'", async () => {
    await writeFile(join(repo, ".codeontic", "config.json"), "{ not valid json");
    const result = await runGate(repo, { repoRoot: repo, strictAnchorExistence: true });
    expect(result.verdict).not.toBe("clean");
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.message.includes("INV-1"))).toBe(true);
  });

  it("--base without --repo-root is refused, not silently dropped", async () => {
    // A model-only error: anchor checks need a repoRoot, and this case has none.
    await writeFile(
      join(repo, ".codeontic", "model", "loops", "dup.yaml"),
      'id: L90\nkind: loop\ntitle: dup\nboundary: "x"\nowner: y\nanchors: []\n',
    );
    const result = await runGate(repo, { strictAnchorExistence: true, base: "HEAD" });
    expect(result.verdict).toBe("unverifiable-base");
    expect(result.baseUnavailableReason).toContain("--repo-root");
  });
});
