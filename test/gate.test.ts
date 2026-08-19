import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderGateMarkdown, renderGateText } from "../src/cli/commands/gate-render.js";
import { redactRoots, runGate } from "../src/cli/commands/gate.js";
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
    //
    // The anchors are REWRITTEN outright rather than pattern-matched out of the
    // fixture: the previous version of this test looked for a block-sequence
    // anchor line, the fixture writes them inline (`anchors: [...]`), and the
    // no-match branch quietly degraded into asserting the file was non-empty —
    // it stayed green with the key reverted to `check + nodeId`.
    const path = join(repo, ".codeontic", "model", "loops", "main.yaml");
    const original = await readFile(path, "utf8");
    expect(original).toContain('anchors: ["src/synth/main.ts#SynthLoop"]');

    // Base: L90 has ONE broken anchor.
    await writeFile(
      path,
      original.replace(
        'anchors: ["src/synth/main.ts#SynthLoop"]',
        'anchors: ["src/synth/gone-a.ts#SynthLoop"]',
      ),
    );
    await git("add", "-A");
    await git("commit", "-qm", "one broken anchor at base");

    // HEAD: the same broken anchor PLUS a second one on the same node.
    await writeFile(
      path,
      original.replace(
        'anchors: ["src/synth/main.ts#SynthLoop"]',
        'anchors: ["src/synth/gone-a.ts#SynthLoop", "src/synth/gone-b.ts#SynthLoop"]',
      ),
    );
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("new-errors");
    expect(result.exitCode).toBe(1);
    // Precisely one is new; the base one must NOT be re-blamed on this change.
    expect(result.newErrors).toHaveLength(1);
    expect(result.newErrors[0]?.message).toContain("gone-b.ts");
  });

  it("relative targetDir/repoRoot at the LIBRARY entry still compares correctly", async () => {
    // Only the normalisation inside runGate protects this path — the CLI's own
    // resolvePath does not run here.
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");
    await git("add", "-A");
    await git("commit", "-qm", "broken at base");

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const result = await runGate(".", {
        repoRoot: ".",
        strictAnchorExistence: true,
        base: "HEAD",
      });
      expect(result.verdict).toBe("preexisting");
      expect(result.exitCode).toBe(0);
    } finally {
      process.chdir(cwd);
    }
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

  it("--base without --repo-root fails even on a CLEAN model — empty means 'not checked'", async () => {
    // The dangerous shape: a workflow whose repo-root variable is empty. The
    // anchor and INV-1 layers never run, the error set is therefore empty, and
    // a clean-first short-circuit would call that a pass.
    const result = await runGate(repo, { strictAnchorExistence: true, base: "HEAD" });
    expect(result.verdict).toBe("unverifiable-base");
    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(renderGateMarkdown(result)).toContain("没查");
  });

  it("a model file with a CJK name is still scorable at base", async () => {
    // `git ls-tree --name-only` without `-z` C-escapes and re-quotes such a
    // path; `git show <ref>:<escaped>` then exits 128 and the whole base side
    // reads as "no model at base" — a permanent red for every PR in the repo.
    const dir = join(repo, ".codeontic", "model", "loops");
    await writeFile(
      join(dir, "主循环.yaml"),
      '- id: L91\n  kind: loop\n  title: CJK 文件名\n  boundary: "a → b"\n  owner: null\n  dormant: true\n',
    );
    await git("add", "-A");
    await git("commit", "-qm", "cjk-named model file");
    await breakAnchor("loops/main.yaml", ".ts#", "-GONE.ts#");

    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("new-errors");
    expect(result.baseUnavailableReason).toBeUndefined();
  });

  it("a config.json broken on the trunk is preexisting, not blamed on this change", async () => {
    // Before: the HEAD side scored `inv1ConfigError` and the base side could
    // not, so one bad commit on main turned every unrelated PR red.
    await writeFile(join(repo, ".codeontic", "config.json"), "{ this is not json");
    await git("add", "-A");
    await git("commit", "-qm", "broken config on the trunk");

    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.errors.some((v) => v.check === "codeontic-config")).toBe(true);
    expect(result.verdict).toBe("preexisting");
    expect(result.exitCode).toBe(0);
  });

  it("a config.json broken BY this change is new-errors and points at the config", async () => {
    await writeFile(join(repo, ".codeontic", "config.json"), "{ this is not json");
    const result = await runGate(repo, {
      repoRoot: repo,
      strictAnchorExistence: true,
      base: "HEAD",
    });
    expect(result.verdict).toBe("new-errors");
    expect(result.exitCode).toBe(1);
    const md = renderGateMarkdown(result);
    expect(md).toContain("config.json");
    // and NOT the wrong instruction to go fix the model
    expect(md).not.toContain("按上面每条的 message 修模型");
  });
});

describe("advisoryCount counts only what falsifies 'model and code agree'", () => {
  it("standing warnings (duplicate anchors) do not append a caveat to every green run", async () => {
    // pilot carries 8 such warnings permanently. Counting them would put a
    // notice on every single passing run, which is a notice nobody reads.
    const path = join(repo, ".codeontic", "model", "loops", "main.yaml");
    const original = await readFile(path, "utf8");
    // Two nodes claiming the same anchor → anchor-duplicate (a warning).
    await writeFile(
      path,
      original.replace(
        'anchors: ["src/synth/dormant.ts#DormantHandler"]',
        'anchors: ["src/synth/main.ts#SynthLoop"]',
      ),
    );
    const result = await runGate(repo, { repoRoot: repo });
    expect(result.verdict).toBe("clean");
    expect(result.advisoryCount).toBe(0);
    expect(renderGateText(result)).toContain("no model errors");
  });

  it("a deleted anchored file DOES count — that is the case the sentence would lie about", async () => {
    await rm(join(repo, "src", "synth", "main.ts"));
    const result = await runGate(repo, { repoRoot: repo });
    expect(result.verdict).toBe("clean");
    expect(result.advisoryCount).toBeGreaterThan(0);
    expect(renderGateText(result)).toContain("do not exist");
  });
});

describe("clean-verdict caveats stack", () => {
  /** A clean result carrying both caveats at once. */
  const bothCaveats = {
    verdict: "clean" as const,
    exitCode: 0 as const,
    check: {
      t0: { ok: true, violations: [] },
      debtIds: new Set<string>(),
      coverage: { inv1Active: true, nodeCount: 1 },
    },
    errors: [],
    newErrors: [],
    scope: "full" as const,
    advisoryCount: 3,
    baseUnavailableReason: "no merge-base",
  };

  // Each renderer is checked SEPARATELY: `--format github` prints both, so an
  // end-to-end assertion passes as long as either one says the thing — which is
  // how a regression in the markdown renderer hid behind the text one.
  it("the text verdict states both", () => {
    const text = renderGateText(bothCaveats);
    expect(text).toContain("advisory");
    expect(text).toContain("基线没能打分");
  });

  it("the markdown verdict states both", () => {
    const md = renderGateMarkdown(bothCaveats);
    expect(md).toContain("advisory");
    expect(md).toContain("基线没能打分");
    expect(md).not.toContain("✅ 模型与代码一致，没有 error。");
  });
});

describe("redactRoots", () => {
  it("ignores relative roots — replacing '.' would rewrite every path in the message", () => {
    const msg = 'anchor "src/synth/main.ts#SynthLoop" does not exist under .';
    expect(redactRoots(msg, [".", "."])).toBe(msg);
  });

  it("replaces absolute roots, longest first so a nested root wins", () => {
    const msg = "missing under /tmp/repo/services/api (root /tmp/repo)";
    expect(redactRoots(msg, ["/tmp/repo", "/tmp/repo/services/api"])).toBe(
      "missing under <root> (root <root>)",
    );
  });

  it("ignores the filesystem root, which would match everywhere", () => {
    const msg = "a/b under /x";
    expect(redactRoots(msg, ["/"])).toBe(msg);
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
