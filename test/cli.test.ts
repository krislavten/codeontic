import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAdapter } from "../src/adapters/registry.js";
import { ADAPTER_INTERFACE_VERSION } from "../src/adapters/types.js";
import { runCheck } from "../src/cli/commands/check.js";
import { runInit, versionToPinSpec } from "../src/cli/commands/init.js";
import { run } from "../src/cli/run.js";
import { COMPONENT_ROLES } from "../src/config/components.js";
import { MARKER_END, MARKER_START } from "../src/hosts/sections.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

/**
 * Deny pattern for target-repo internals in anything the npm package ships
 * (README, dist/): table names, package paths, queue/channel names, symbol
 * names, loop ids. This repo is public, so the pattern itself is NOT tracked —
 * a committed denylist of internal identifiers would itself be the leak. The
 * maintainer supplies it via `CODEONTIC_DENY_PATTERN` (a case-insensitive JS
 * regex source) in private CI / local env; when unset, the guards that need it
 * pass vacuously (see each test's early return).
 *
 * Pattern-writing guidance, kept from when the list was tracked (#37):
 * - compound terms: `word1[-_/]word2` so one token catches the hyphen, slash,
 *   AND UPPER_SNAKE spellings — `/i` folds case only, never punctuation;
 * - single-word names: bound with `(?<![A-Za-z0-9])`/`(?![A-Za-z0-9])`, not
 *   `\b` — `_` IS a word character, so `\bname\b` misses `NAME_TOKEN`, the
 *   exact spelling a leaked constant takes; excluding only alphanumerics keeps
 *   `\b`'s false-positive protection (substrings inside ordinary words stay
 *   clean). The recipe test below pins both shapes with neutral terms.
 */
const PUBLISH_DENY = process.env.CODEONTIC_DENY_PATTERN
  ? new RegExp(process.env.CODEONTIC_DENY_PATTERN, "i")
  : undefined;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-cli-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runInit", () => {
  it("creates the .codeontic/ unified skeleton — model/, adapter/, config.json, agent kit", async () => {
    const result = await runInit(workDir);
    // skip-if-exists files go to `created`
    expect(result.created.sort()).toEqual(
      [
        ".codeontic/model/README.md",
        ".codeontic/model/baseline/",
        ".codeontic/model/flows/",
        ".codeontic/model/junctions/",
        ".codeontic/model/loops/",
        ".codeontic/model/scenarios/",
        ".codeontic/adapter/README.md",
        ".codeontic/adapter/package.json",
        ".codeontic/config.json",
      ].sort(),
    );
    // managed-section files go to `managed` with outcome "created"
    const managedFiles = result.managed.map((m) => m.file).sort();
    expect(managedFiles).toEqual(
      [
        ".codeontic/agent/loop-discovery.md",
        ".codeontic/agent/loop-discovery-parallel.md",
        ".codeontic/agent/setup-pr-template.md",
        ".codeontic/agent/setup-github-actions.md",
        ".claude/skills/codeontic/SKILL.md",
      ].sort(),
    );
    for (const m of result.managed) expect(m.outcome).toBe("created");

    const readme = await readFile(join(workDir, ".codeontic", "model", "README.md"), "utf8");
    expect(readme).toContain(".codeontic/model/");
    const adapterReadme = await readFile(
      join(workDir, ".codeontic", "adapter", "README.md"),
      "utf8",
    );
    expect(adapterReadme).toContain("interfaceVersion");
    expect(adapterReadme).toContain(`interfaceVersion: "${ADAPTER_INTERFACE_VERSION}"`);
    const config = await readFile(join(workDir, ".codeontic", "config.json"), "utf8");
    expect(JSON.parse(config)).toEqual({
      guardedTables: {},
      aliases: {},
      unanalyzableExceptions: [],
      _components: expect.stringContaining(`role: ${COMPONENT_ROLES.join("|")}`),
      components: [],
    });
    const { loadComponents } = await import("../src/config/components.js");
    const { loadInv1Config } = await import("../src/validate/inv1/config.js");
    expect(await loadComponents(workDir)).toEqual({ components: [] });
    expect((await loadInv1Config(workDir)).error).toBeUndefined();
    const discovery = await readFile(join(workDir, ".codeontic/agent/loop-discovery.md"), "utf8");
    expect(discovery).toContain("Pass 2 — 证伪");
    // managed files must contain markers
    expect(discovery).toContain(MARKER_START);
    expect(discovery).toContain(MARKER_END);
  });

  /**
   * The skeleton is copy-paste starting material, so the only assertion that
   * really means anything is whether the copied thing LOADS. Checking the
   * README's prose alone is how it came to sit at a stale `interfaceVersion`
   * that the registry rejects — the doc looked fine, and nothing executed it.
   */
  it("the adapter skeleton in the generated README actually passes registry validation", async () => {
    await runInit(workDir);
    const adapterReadme = await readFile(
      join(workDir, ".codeontic", "adapter", "README.md"),
      "utf8",
    );
    const block = adapterReadme.match(/```ts\n([\s\S]*?)```/);
    expect(block, "adapter README must carry a fenced ts example").toBeTruthy();

    const fs = await import("node:fs/promises");
    const modPath = join(workDir, "skeleton-adapter.mjs");
    await fs.writeFile(modPath, block?.[1] ?? "", "utf8");
    const mod = await import(pathToFileURL(modPath).href);

    // Exactly what run.ts does with a discovered adapter module.
    expect(() => validateAdapter(mod.default)).not.toThrow();
    // …and it really is the sync, empty-by-default extractor it claims to be.
    expect(mod.default.extractFacts("a.ts", "someCallShape(", undefined)).toEqual([]);
  });

  it("is idempotent: skip-if-exists files preserved; managed files report unchanged on second run", async () => {
    await runInit(workDir);
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      join(workDir, ".codeontic", "model", "README.md"),
      "user-edited content",
      "utf8",
    );
    await fs.writeFile(
      join(workDir, ".codeontic", "config.json"),
      '{"guardedTables":{"x":1}}',
      "utf8",
    );
    const second = await runInit(workDir);
    expect(second.skipped).toContain(".codeontic/model/README.md");
    expect(second.skipped).toContain(".codeontic/config.json");
    // Managed files should report "unchanged" on second run (content hasn't changed)
    const prTemplate = second.managed.find(
      (m) => m.file === ".codeontic/agent/setup-pr-template.md",
    );
    expect(prTemplate?.outcome).toBe("unchanged");
    const readme = await readFile(join(workDir, ".codeontic", "model", "README.md"), "utf8");
    expect(readme).toBe("user-edited content");
    const config = await readFile(join(workDir, ".codeontic", "config.json"), "utf8");
    expect(config).toBe('{"guardedTables":{"x":1}}');
  });

  /**
   * 016 D6. The adapter skeleton teaches ESM (`export default`), and the engine
   * loads it with `import()`. In a target repo whose ROOT package.json is CJS or
   * absent, Node prints a MODULE_TYPELESS_PACKAGE_JSON warning on every
   * adapter-loading command — verified by hand: deleting this file brings the
   * warning back on `codeontic facts`. Asserting the parsed contents (not the
   * bytes) because `type: module` is the load-bearing part.
   */
  it("scopes the adapter directory to ESM so Node stops warning about a typeless package (D6)", async () => {
    await runInit(workDir);
    const pkg = await readFile(join(workDir, ".codeontic", "adapter", "package.json"), "utf8");
    expect(JSON.parse(pkg)).toMatchObject({ type: "module" });

    // Idempotent like the rest of the skeleton: a repo whose adapter is a build
    // output may keep its own package.json here, and a re-run must not clobber it.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      join(workDir, ".codeontic", "adapter", "package.json"),
      '{"type":"module","name":"my-adapter"}',
      "utf8",
    );
    const second = await runInit(workDir);
    expect(second.skipped).toContain(".codeontic/adapter/package.json");
    expect(await readFile(join(workDir, ".codeontic", "adapter", "package.json"), "utf8")).toBe(
      '{"type":"module","name":"my-adapter"}',
    );
  });

  /**
   * 016 T1: `init` produces a skeleton, not a model. A run that ends on the file
   * list leaves the reader believing the tool did the modeling — early target-repo
   * evaluation found every first-run user inventing their own next step. Asserted
   * through `run()` (real stdout ordering), not just on the constant, because
   * "comes last, after the file list" is half the point.
   */
  it("init's exit guidance names the next action, the parallel route, and the cost (T1)", async () => {
    const lines: string[] = [];
    const code = await run(["init", workDir], { log: (m) => lines.push(m), error: () => {} });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("/codeontic");
    expect(out).toContain("loop-discovery-parallel.md");
    expect(out).toContain("成本");
    // ordering: guidance after every per-file line
    const lastFileLine = lines.reduce(
      (acc, l, i) => (/^(created|skipped|managed) /.test(l) ? i : acc),
      -1,
    );
    const guidance = lines.findIndex((l) => l.includes("下一步"));
    expect(guidance).toBeGreaterThan(lastFileLine);
  });

  it("legacy kit file without markers → skipped with migration hint, not auto-rewritten", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(workDir, ".codeontic", "agent"), { recursive: true });
    await fs.writeFile(
      join(workDir, ".codeontic/agent/setup-pr-template.md"),
      "customized by repo — no markers",
      "utf8",
    );
    const result = await runInit(workDir);
    expect(result.skipped).toContain(".codeontic/agent/setup-pr-template.md");
    expect(result.migrationHints).toContain(".codeontic/agent/setup-pr-template.md");
    const kit = await readFile(join(workDir, ".codeontic/agent/setup-pr-template.md"), "utf8");
    expect(kit).toBe("customized by repo — no markers");
  });
});

describe("agent kit assets (Proposal 009)", () => {
  it("shipped kit leaks no target-repo internals (compiles into the PUBLIC npm package)", async () => {
    const {
      LOOP_DISCOVERY_PROMPT,
      LOOP_DISCOVERY_PARALLEL_PROMPT,
      CODEONTIC_SKILL,
      SETUP_PR_TEMPLATE_PROMPT,
      setupGithubActionsPrompt,
    } = await import("../src/cli/assets/agent-kit.js");
    for (const text of [
      LOOP_DISCOVERY_PROMPT,
      LOOP_DISCOVERY_PARALLEL_PROMPT,
      SETUP_PR_TEMPLATE_PROMPT,
      setupGithubActionsPrompt("0.5"),
      CODEONTIC_SKILL,
    ]) {
      // target-repo internals must never appear in the generic shipped kit.
      // The pattern is env-supplied (see PUBLISH_DENY above) — without it this
      // loop still exercises the kit constants end to end.
      if (PUBLISH_DENY) expect(text).not.toMatch(PUBLISH_DENY);
    }
  });

  it("the /codeontic skill front door has valid frontmatter and routes to every capability", async () => {
    const { CODEONTIC_SKILL } = await import("../src/cli/assets/agent-kit.js");
    // Claude Code discovers a project skill by its `name:` frontmatter key.
    expect(CODEONTIC_SKILL.startsWith("---\n")).toBe(true);
    expect(CODEONTIC_SKILL).toMatch(/^name:\s*codeontic$/m);
    expect(CODEONTIC_SKILL).toMatch(/^description:/m);
    // The front door must actually point at each capability, not just exist.
    for (const cmd of ["check", "conformance", "graph", "reconcile", "coverage", "mcp"]) {
      expect(CODEONTIC_SKILL).toContain(`codeontic ${cmd}`);
    }
    // And carry the one non-negotiable: the model is the source of truth.
    expect(CODEONTIC_SKILL).toContain("模型是事实源");
  });

  it("init writes the /codeontic skill to the Claude Code project-skill path, with managed sections", async () => {
    const first = await runInit(workDir);
    const skillEntry = first.managed.find((m) => m.file === ".claude/skills/codeontic/SKILL.md");
    expect(skillEntry?.outcome).toBe("created");
    const skill = await readFile(
      join(workDir, ".claude", "skills", "codeontic", "SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/^name:\s*codeontic$/m);
    expect(skill).toContain(MARKER_START);

    // Second run → unchanged (content hasn't changed)
    const second = await runInit(workDir);
    const secondEntry = second.managed.find((m) => m.file === ".claude/skills/codeontic/SKILL.md");
    expect(secondEntry?.outcome).toBe("unchanged");
  });

  it("legacy SKILL.md without markers → skipped with migration hint", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(workDir, ".claude", "skills", "codeontic"), { recursive: true });
    await fs.writeFile(
      join(workDir, ".claude/skills/codeontic/SKILL.md"),
      "custom skill without markers",
      "utf8",
    );
    const result = await runInit(workDir);
    expect(result.skipped).toContain(".claude/skills/codeontic/SKILL.md");
    expect(result.migrationHints).toContain(".claude/skills/codeontic/SKILL.md");
  });

  it("README (force-shipped by npm) leaks no target-repo internals", async () => {
    if (!PUBLISH_DENY) return; // pattern is env-supplied; without it there is nothing to assert
    const readme = await readFile(join(import.meta.dirname, "..", "README.md"), "utf8");
    expect(readme).not.toMatch(PUBLISH_DENY);
  });

  it("the deny-pattern recipe catches UPPER_SNAKE spellings without flagging ordinary words (#37)", () => {
    // #32 shipped a `"…_PLANE_URL"`-style leak that a `\b`-bounded, hyphen-only
    // pattern missed. The real pattern is env-supplied and untracked, so the
    // RECIPE — the two boundary shapes documented on PUBLISH_DENY above — is
    // pinned here with neutral stand-in terms. A maintainer's pattern should
    // follow exactly these shapes.
    const RECIPE = /(?<![A-Za-z0-9])acmeproj(?![A-Za-z0-9])|secret[-_]plane/i;
    const leaks = [
      'export const SECRET_PLANE_URL = "https://…";', // the #32 incident shape
      "const x = ctx.env._SECRET_PLANE_URL;",
      "ACMEPROJ_API_KEY", // `_` is a word char — `\bacmeproj\b` would miss this
      "NEXT_PUBLIC_ACMEPROJ_TOKEN",
    ];
    for (const leak of leaks) {
      expect(leak, `expected recipe to catch: ${leak}`).toMatch(RECIPE);
    }
    const prose = [
      "acmeprojection is a different word entirely", // alnum boundary holds
      "the secretplaneswap constant is unrelated", // compound needs a separator
    ];
    for (const p of prose) {
      expect(p, `expected recipe NOT to flag: ${p}`).not.toMatch(RECIPE);
    }
  });

  it("the published package carries dist only — docs/prompts and examples never ship", () => {
    // Regression guard on package.json `files`: a misconfiguration here would
    // leak repo docs/prompts into the PUBLIC npm package.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const out = execFileSync(npm, ["pack", "--dry-run", "--json"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const [pack] = JSON.parse(out) as [{ files: { path: string }[] }];
    const offenders = pack.files
      .map((f) => f.path)
      .filter((p) => p.startsWith("docs/") || p.startsWith("examples/") || p.startsWith("test/"));
    expect(offenders).toEqual([]);
  });

  it("the built dist/ leaks no target-repo business identifiers", async () => {
    if (!PUBLISH_DENY) return; // pattern is env-supplied; without it there is nothing to assert
    // Scans the ACTUAL compiled output that ships, not just the src. Guards the
    // red line: publishing codeontic must not expose any target repo's internals
    // (table names, package paths, queue names, symbol names, loop ids). Proposal
    // 010: no adapter ships in this package at all, so no target-repo identifier
    // has a legitimate reason to appear in dist/.
    const { readdir, readFile } = await import("node:fs/promises");
    const distRoot = join(import.meta.dirname, "..", "dist");
    // Decode every JS escape form tsc could emit (\uXXXX, \u{...}, \xXX) before
    // matching, so an escaped identifier can't slip past a plaintext scan.
    const deEscape = (s: string) =>
      s
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
    const TEXT = /\.(js|d\.ts|ts|json)$/; // scan exactly what ships — .map is excluded via package.json files, so don't scan it
    async function* walk(dir: string): AsyncGenerator<string> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (TEXT.test(e.name)) yield p;
      }
    }
    const offenders: string[] = [];
    for await (const file of walk(distRoot)) {
      const raw = await readFile(file, "utf8").catch(() => ""); // skip anything unreadable as text
      const m = deEscape(raw).match(PUBLISH_DENY);
      if (m) offenders.push(`${file}: ${m[0]}`);
    }
    expect(offenders, `dist leaks target internals:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("init completes the kit when .codeontic/agent/ pre-exists but is empty", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(workDir, ".codeontic", "agent"), { recursive: true });
    const result = await runInit(workDir);
    const discoveryEntry = result.managed.find(
      (m) => m.file === ".codeontic/agent/loop-discovery.md",
    );
    expect(discoveryEntry?.outcome).toBe("created");
    const discovery = await readFile(join(workDir, ".codeontic/agent/loop-discovery.md"), "utf8");
    expect(discovery).toContain("Pass 1");
  });

  it("shipped discovery prompt carries the full 4-pass skeleton", async () => {
    const { LOOP_DISCOVERY_PROMPT } = await import("../src/cli/assets/agent-kit.js");
    for (const heading of [
      "Pass 1 — 穷举候选(loop 候选 + 路径候选)",
      "Pass 2 — 证伪(杀死伪 loop)",
      "Pass 3 — loop 之上的 loop(组合)",
      "Pass 4 — trace 升维",
    ]) {
      expect(LOOP_DISCOVERY_PROMPT).toContain(heading);
    }
  });

  /**
   * T1's Definition of Done was "the discovery pipeline teaches anchored flow".
   * Asserting only the Pass 1 HEADING would let someone delete the entire
   * B-class section and keep the suite green — and the claude-code before/after
   * showed exactly what that costs: with the old instructions the agent found
   * 6 loops and bound zero flows to code, missing the CLI entry chain and pipe
   * mode outright. The schema capability is useless if the pipeline never emits
   * it, so the guidance itself is the artifact under test.
   */
  it("shipped discovery prompt teaches anchored flow, not just loops (T1 DoD)", async () => {
    const { LOOP_DISCOVERY_PROMPT, CODEONTIC_SKILL } = await import(
      "../src/cli/assets/agent-kit.js"
    );
    for (const required of [
      "B 类 — 路径候选", // Pass 1 recalls one-shot execution paths at all
      "anchored", // the shape a path candidate becomes
      "composed", // ...and the one it must be distinguished from
      "不是** bootstrap", // Pass 2 stops killing CLI paths as boot tasks
      "这条旅程的代码在哪", // the composed/anchored decision rule
    ]) {
      expect(LOOP_DISCOVERY_PROMPT).toContain(required);
    }
    // the front door must route a zero-loop repo somewhere other than an empty model
    expect(CODEONTIC_SKILL).toContain("anchored");
  });

  /**
   * 016 T2. Every clause asserted here is a FIXED INCIDENT from one real
   * five-domain, sixty-node modeling run — the same reason the anchored-flow
   * assertions above exist. Asserting only the file's presence would let the
   * body be emptied while the suite stays green, and each of these rules is the
   * only thing standing between the next big-repo run and the accident that
   * produced it:
   *   - behavior-not-package domains → two domains claiming one cross-package
   *     behavior, i.e. the same loop modeled twice;
   *   - id ranges as the ONLY isolation → a domain that invented a filename
   *     prefix and produced 30 filename-vs-id warnings;
   *   - behavior language → a whole round of titles written as call chains,
   *     which the report's "what does it do" column exposed as unreadable;
   *   - the merge checklist → duplicate anchors and stale free-text id
   *     references surviving multiple rounds.
   */
  it("shipped parallel prompt carries every rule its real incidents produced (T2)", async () => {
    const { LOOP_DISCOVERY_PARALLEL_PROMPT: P, CODEONTIC_SKILL } = await import(
      "../src/cli/assets/agent-kit.js"
    );
    for (const required of [
      "150", // the routing threshold, so a reader knows when this file applies
      "按行为归属,不按包归属", // the domain-splitting rule
      "防的事故", // every rule states the accident it prevents
      "file-per-node", // why id ranges suffice as the isolation mechanism
      "禁止给文件名另加域前缀",
      "行为语言规约",
      "重复锚点裁决",
      "跨包 flow 补建",
      "自由文本 id 引用核对",
      "--strict-anchors", // the merge stage's exit gate
      "诚实优先于覆盖率",
    ]) {
      expect(P, `parallel prompt must teach: ${required}`).toContain(required);
    }
    // the id-prefix conventions, which until now existed only in schema regexes
    expect(P).toContain("id 前缀约定");
    for (const idForm of ["`C1`", "`J-", "`GWT-L12-001`", "`DEBT-"]) expect(P).toContain(idForm);
    // and the front door must ROUTE a big repo here, or the file is unreachable
    expect(CODEONTIC_SKILL).toContain("loop-discovery-parallel.md");
  });

  /**
   * 016 T8. The CI prompt used to describe two LLM workflows only, so a repo
   * that followed it end to end still had no report card in its PRs, no
   * retained snapshot, and no path for `--drift-json` (which is unusable
   * without a prior snapshot to diff against — the flag hard-errors without
   * `--drift`). Asserting the flag spellings too: these are copied into
   * generated workflows verbatim, and a wrong one fails only in the target
   * repo's CI, where nobody here would see it.
   */
  it("CI prompt covers advisory conformance, nightly snapshot, and --drift-json delivery (T8)", async () => {
    const { setupGithubActionsPrompt } = await import("../src/cli/assets/agent-kit.js");
    const text = setupGithubActionsPrompt("0.9");
    expect(text).toContain("conformance . --repo-root .");
    expect(text).toContain("--drift-json");
    expect(text).toContain("--drift <base-snapshot.json>");
    expect(text).toContain("snapshot . --repo-root . --out snapshot.json");
    // advisory, never a gate: the report card is explicitly run WITHOUT --strict
    expect(text).toContain("不加 `--strict`");
    expect(text).toContain("永不阻塞 PR");
  });
});

describe("runCheck", () => {
  it("passes T0 on a real seeded model", async () => {
    await seedSyntheticModel(workDir);
    const result = await runCheck(workDir);
    expect(result.t0.ok).toBe(true);
    expect(result.t0.violations).toEqual([]);
    expect(result.inv1).toBeUndefined(); // no repoRoot → INV-1 not run
  });

  it("fails T0 when the model dir has a schema violation", async () => {
    await seedSyntheticModel(workDir);
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      join(workDir, ".codeontic", "model", "loops", "broken.yaml"),
      "id: L1\ntitle: no kind\n",
      "utf8",
    );
    const result = await runCheck(workDir);
    expect(result.t0.ok).toBe(false);
    expect(result.t0.violations.some((v) => v.check === "schema")).toBe(true);
  });
});

describe("run() — CLI dispatch", () => {
  it("init → seed → check end-to-end via the same entry point tests exercise", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    expect(await run(["init", workDir], io)).toBe(0);
    await seedSyntheticModel(workDir);
    const checkExit = await run(["check", workDir], io);
    expect(checkExit).toBe(0);
    expect(logs.some((l) => l.includes("T0 passed"))).toBe(true);
  });

  it("returns exit code 1 and an error line for an unknown command", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["bogus-command"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.startsWith("ERR:") && l.includes("unknown command"))).toBe(true);
  });

  it("rejects --repo-root given with no value instead of silently skipping anchor-existence", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    // "--repo-root" is the last token, so parseFlags records it as boolean true, not a path.
    const exitCode = await run(["check", workDir, "--repo-root"], io);
    expect(exitCode).toBe(1);
    expect(
      logs.some((l) => l.startsWith("ERR:") && l.includes("--repo-root requires a value")),
    ).toBe(true);
  });

  it("rejects --adapter-path given with no value on facts", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["facts", workDir, "--adapter-path"], io);
    expect(exitCode).toBe(1);
    expect(
      logs.some((l) => l.startsWith("ERR:") && l.includes("--adapter-path requires a value")),
    ).toBe(true);
  });

  /**
   * An adapter that emits BOTH a registerable background unit and a fact of a
   * different nature (a topology edge). Reconciliation is only about the
   * former: nothing in the model is supposed to "register" an outbound edge.
   *
   * Left unscoped, those facts land in `unregistered` and swamp it — measured
   * on a real target, 6 genuinely-unregistered facts became 69 the moment the
   * adapter started emitting topology hints. The one number the model is
   * steered by would then be ~90% noise, and an advisory signal that cries
   * wolf gets ignored.
   */
  it("reconcile scopes to `reconcilableSignalKinds`, and says out loud how many facts that excluded", async () => {
    const fs = await import("node:fs/promises");
    const adapterFile = join(workDir, "scoped-adapter.mjs");
    await fs.writeFile(
      adapterFile,
      [
        "export default {",
        '  interfaceVersion: "v2",',
        '  name: "scoped",',
        '  version: "scoped-1",',
        '  candidatePattern: "MARKER",',
        '  reconcilableSignalKinds: ["synthetic_poller"],',
        "  extractFacts(filePath, content) {",
        '    if (!content.includes("MARKER")) return [];',
        "    return [",
        '      { signal: "synthetic_poller", name: "tick", filePath, line: 1 },',
        '      { signal: "outbound_edge", name: "SOME_URL", filePath, line: 2,',
        '        topology: { to: "some-service", toKind: "service" } },',
        "    ];",
        "  },",
        "};",
      ].join("\n"),
      "utf8",
    );
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workDir });
    await fs.mkdir(join(workDir, "src"), { recursive: true });
    await fs.writeFile(join(workDir, "src", "w.ts"), "const x = 1; // MARKER\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });
    await seedSyntheticModel(workDir);

    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(
      ["reconcile", workDir, "--repo-root", workDir, "--adapter-path", adapterFile, "--no-cache"],
      io,
    );
    expect(exitCode).toBe(0);
    const summary = logs.find((l) => l.startsWith("reconcile:"));
    // Denominator is the IN-SCOPE fact only — the edge is not diluting it.
    expect(summary).toContain("/1 fact(s)");
    // The out-of-scope fact must NOT be reported as an unregistered finding...
    expect(logs.some((l) => l.includes("unregistered outbound_edge"))).toBe(false);
    // ...but the narrowing itself must be VISIBLE. A denominator that quietly
    // shrinks reads exactly like facts going missing, which is the failure
    // this check exists to catch.
    expect(
      logs.some((l) => l.includes("outside reconciliation scope") && l.includes("1 fact(s)")),
    ).toBe(true);
  });

  /**
   * The back-compat half of the contract above. Every adapter written before
   * `reconcilableSignalKinds` existed omits it, and MUST keep reconciling
   * everything — treating "undeclared" as "nothing reconciles" would silently
   * switch the check off for every existing target, which is a far worse
   * failure than the noise this field exists to remove.
   */
  it("an adapter that declares no reconcilableSignalKinds still reconciles every kind, with no scope line", async () => {
    const fs = await import("node:fs/promises");
    const adapterFile = join(workDir, "unscoped-adapter.mjs");
    await fs.writeFile(
      adapterFile,
      [
        "export default {",
        '  interfaceVersion: "v2",',
        '  name: "unscoped",',
        '  version: "unscoped-1",',
        '  candidatePattern: "MARKER",',
        "  extractFacts(filePath, content) {",
        '    if (!content.includes("MARKER")) return [];',
        "    return [",
        '      { signal: "synthetic_poller", name: "tick", filePath, line: 1 },',
        '      { signal: "outbound_edge", name: "SOME_URL", filePath, line: 2 },',
        "    ];",
        "  },",
        "};",
      ].join("\n"),
      "utf8",
    );
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workDir });
    await fs.mkdir(join(workDir, "src"), { recursive: true });
    await fs.writeFile(join(workDir, "src", "w.ts"), "const x = 1; // MARKER\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });
    await seedSyntheticModel(workDir);

    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(
      ["reconcile", workDir, "--repo-root", workDir, "--adapter-path", adapterFile, "--no-cache"],
      io,
    );
    expect(exitCode).toBe(0);
    // BOTH facts are in scope — denominator is 2, not 1.
    expect(logs.find((l) => l.startsWith("reconcile:"))).toContain("/2 fact(s)");
    // The edge IS reported as unregistered here, because this adapter never
    // said reconciliation wasn't about it.
    expect(logs.some((l) => l.includes("unregistered outbound_edge"))).toBe(true);
    // And nothing claims anything was scoped out.
    expect(logs.some((l) => l.includes("outside reconciliation scope"))).toBe(false);
  });

  it("facts --adapter-path resolves an external adapter module (Proposal 010: no built-in adapter)", async () => {
    const fs = await import("node:fs/promises");
    const adapterFile = join(workDir, "my-adapter.mjs");
    await fs.writeFile(
      adapterFile,
      [
        "export default {",
        '  interfaceVersion: "v2",',
        '  name: "synthetic",',
        '  version: "synthetic-1",',
        '  candidatePattern: "MARKER",',
        "  extractFacts(filePath, content) {",
        '    if (!content.includes("MARKER")) return [];',
        '    return [{ signal: "synthetic_marker", name: "found", filePath, line: 1 }];',
        "  },",
        "};",
      ].join("\n"),
      "utf8",
    );
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workDir });
    await fs.mkdir(join(workDir, "src"), { recursive: true });
    await fs.writeFile(join(workDir, "src", "w.ts"), "const x = 1; // MARKER\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });

    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["facts", workDir, "--adapter-path", adapterFile, "--no-cache"], io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("synthetic_marker"))).toBe(true);
    expect(logs.some((l) => l.includes("found"))).toBe(true);
    // A1 positive tripwire: a loaded adapter announces itself by name+version+path.
    // The absence of this exact line in a CI log is what distinguishes a genuine
    // adapter-less repo from one whose adapter silently failed to build/install.
    expect(logs.some((l) => l.includes('adapter "synthetic" v') && l.includes("loaded from"))).toBe(
      true,
    );
  });

  it("facts with no --adapter-path and no .codeontic/adapter/ convention path shows the loud NO-ADAPTER banner and exits 0", async () => {
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["facts", workDir], io);
    expect(exitCode).toBe(0);
    // A1: no longer a single easily-missed ⚠ line — a bannered "reconciliation is
    // OFF" block. Non-strict, so it still exits 0.
    expect(logs.some((l) => l.includes("NO ADAPTER — implementation reconciliation is OFF"))).toBe(
      true,
    );
  });

  it("check --repo-root <dir> surfaces advisory anchor-existence warnings without failing T0", async () => {
    // The Phase 0 seed itself has zero anchors (grounding loops in real
    // code anchors is Phase 1 work), so this needs its own minimal
    // fixture with one anchor that can't resolve under `workDir`, to
    // exercise the --repo-root flag actually reaching runCheck's options.
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(workDir, ".codeontic", "model", "loops"), { recursive: true });
    await fs.writeFile(
      join(workDir, ".codeontic", "model", "loops", "l1.yaml"),
      [
        "id: L1",
        "kind: loop",
        "title: x",
        "boundary: b",
        "owner: o",
        "anchors: [does/not/exist.ts#Nope]",
      ].join("\n"),
      "utf8",
    );

    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["check", workDir, "--repo-root", workDir], io);
    expect(exitCode).toBe(0); // advisory warnings don't fail T0
    expect(logs.some((l) => l.includes("⚠") && l.includes("anchor-existence"))).toBe(true);
  });
});

/**
 * A2 (--strict-adapter) × A1 (status banners). The matrix pins down exactly
 * three axes that used to be conflated into "no adapter, exit 0":
 *  - absent vs failed vs loaded (A1 must tell them apart, loudly)
 *  - strict on vs off
 *  - gate-able command (facts/reconcile/conformance — --strict-adapter may halt
 *    on ABSENCE) vs advisory command (graph/overview/snapshot — documented to
 *    always exit 0; --strict-adapter must NOT change that)
 * The invariant a broken adapter (failed) ALWAYS halts — on every command,
 * strict or not — is asserted separately from the absence policy, because they
 * are different rules and a future edit could accidentally couple them.
 */
describe("run() — --strict-adapter (A2) + adapter status (A1)", () => {
  const newIo = () => {
    const logs: string[] = [];
    return {
      logs,
      io: { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) },
    };
  };

  /** Write an adapter .mjs and return its path. `body` overrides the default valid module. */
  async function writeAdapter(name: string, body?: string): Promise<string> {
    const file = join(workDir, `${name}.mjs`);
    await writeFile(
      file,
      body ??
        [
          "export default {",
          `  interfaceVersion: "${ADAPTER_INTERFACE_VERSION}",`,
          `  name: "${name}",`,
          '  version: "1",',
          '  candidatePattern: "MARKER",',
          "  extractFacts() { return []; },",
          "};",
        ].join("\n"),
      "utf8",
    );
    return file;
  }

  it("absent + --strict-adapter on a gate-able command (facts) → hard failure (exit 1)", async () => {
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    const { logs, io } = newIo();
    const exitCode = await run(["facts", workDir, "--strict-adapter"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("NO ADAPTER (--strict-adapter set)"))).toBe(true);
  });

  it("absent + --strict-adapter on conformance (the flagship gate) → hard failure (exit 1)", async () => {
    await runInit(workDir);
    await seedSyntheticModel(workDir);
    const { logs, io } = newIo();
    const exitCode = await run(["conformance", workDir, "--strict-adapter"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("NO ADAPTER (--strict-adapter set)"))).toBe(true);
  });

  // Every advisory command must ignore --strict-adapter on absence (documented
  // "always exit 0" / "never a PR gate"). Parametrized across ALL THREE so a
  // future flip of any one command's gateable flag is caught — graph alone
  // wouldn't notice overview/snapshot regressing. argv is built INSIDE the test
  // because `workDir` is only assigned in beforeEach, after the describe body runs.
  for (const cmd of ["graph", "overview", "snapshot"] as const) {
    it(`absent + --strict-adapter on advisory command '${cmd}' → banner but still exit 0`, async () => {
      await runInit(workDir);
      await seedSyntheticModel(workDir);
      // snapshot needs --repo-root; graph/overview default it to the model dir.
      const argv =
        cmd === "snapshot"
          ? [cmd, workDir, "--repo-root", workDir, "--strict-adapter"]
          : [cmd, workDir, "--strict-adapter"];
      const { logs, io } = newIo();
      const exitCode = await run(argv, io);
      expect(exitCode).toBe(0);
      expect(
        logs.some((l) => l.includes("NO ADAPTER — implementation reconciliation is OFF")),
      ).toBe(true);
      // must NOT print the strict-halt banner, since it didn't halt.
      expect(logs.some((l) => l.includes("--strict-adapter set"))).toBe(false);
    });
  }

  it("a BROKEN adapter (bad module) halts with exit 1 even WITHOUT --strict-adapter", async () => {
    const bad = await writeAdapter("broken", "export default 123;"); // no .name/.interfaceVersion
    const { logs, io } = newIo();
    const exitCode = await run(["facts", workDir, "--adapter-path", bad], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("ADAPTER FAILED TO LOAD"))).toBe(true);
  });

  it("a BROKEN adapter halts with exit 1 WITH --strict-adapter too (strict doesn't relax 'failed')", async () => {
    const bad = await writeAdapter("broken2", "throw new Error('boom at import');");
    const { logs, io } = newIo();
    const exitCode = await run(["facts", workDir, "--adapter-path", bad, "--strict-adapter"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("ADAPTER FAILED TO LOAD"))).toBe(true);
    // The banner must carry the ACTUAL failure detail, not just a generic header —
    // otherwise a future edit could swallow the cause and this test wouldn't notice.
    expect(logs.some((l) => l.includes("boom at import"))).toBe(true);
  });

  it("an interfaceVersion mismatch is a hard failure with the upgrade/pin guidance", async () => {
    const stale = await writeAdapter(
      "stale",
      [
        "export default {",
        '  interfaceVersion: "v1",', // deliberately wrong
        '  name: "stale",',
        '  version: "1",',
        '  candidatePattern: "MARKER",',
        "  extractFacts() { return []; },",
        "};",
      ].join("\n"),
    );
    const { logs, io } = newIo();
    const exitCode = await run(["facts", workDir, "--adapter-path", stale], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("upgrade the adapter or pin codeontic back"))).toBe(true);
  });

  it("a valid explicit adapter loads and announces itself (A1 positive tripwire), exit 0", async () => {
    const good = await writeAdapter("good");
    await runInit(workDir);
    await seedSyntheticModel(workDir);
    const { logs, io } = newIo();
    // conformance is gate-able but a loaded adapter never halts; --strict-adapter is a no-op here.
    const exitCode = await run(
      ["conformance", workDir, "--repo-root", workDir, "--adapter-path", good, "--strict-adapter"],
      io,
    );
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('adapter "good" v1 loaded from'))).toBe(true);
  });
});

/**
 * A3 — generated CI must PIN codeontic, never float on `@latest`. `@latest` is
 * how an integrating repo drifts onto a release that changed gate semantics or
 * the adapter interfaceVersion while its CI stayed green — the silent-failure
 * root cause this pins shut.
 */
describe("versionToPinSpec (A3 — CI version pin)", () => {
  it("pins 0.x to major.minor (a 0.x MINOR bump may break)", () => {
    expect(versionToPinSpec("0.5.1")).toBe("0.5");
    expect(versionToPinSpec("0.5.0")).toBe("0.5");
    expect(versionToPinSpec("0.12.9")).toBe("0.12");
    // 0.0.x boundary: still major.minor ("0.0"), never collapsed to "0" — a
    // 0.0.x tool's every minor can break, so 0.0.1 and 0.1.0 are distinct lines.
    expect(versionToPinSpec("0.0.1")).toBe("0.0");
  });

  it("pins >=1.0 to major (MAJOR is the breaking axis there)", () => {
    expect(versionToPinSpec("1.2.3")).toBe("1");
    expect(versionToPinSpec("2.0.0")).toBe("2");
    expect(versionToPinSpec("10.4.7")).toBe("10");
  });

  it("returns null (NOT 'latest') for an unparseable version — must never emit the forbidden float", () => {
    expect(versionToPinSpec("")).toBeNull();
    expect(versionToPinSpec("not-a-version")).toBeNull();
  });

  it("is fully anchored: junk suffixes and short versions return null, not a loose prefix match", () => {
    expect(versionToPinSpec("1.2.3.4")).toBeNull();
    expect(versionToPinSpec("1.2")).toBeNull();
    expect(versionToPinSpec("1.2.3garbage")).toBeNull();
  });

  it("a prerelease pins to its STABLE line (integrators never depend on our RC)", () => {
    expect(versionToPinSpec("0.5.0-rc.1")).toBe("0.5");
    expect(versionToPinSpec("1.4.0-beta.2")).toBe("1");
    expect(versionToPinSpec("2.0.0+build.5")).toBe("2");
  });
});

describe("init generates a version-pinned GitHub Actions prompt (A3)", () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), "codeontic-a3-"));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it("burns a real pinned version into setup-github-actions.md and never writes @latest", async () => {
    const res = await runInit(d);
    const kit = await readFile(join(d, ".codeontic/agent/setup-github-actions.md"), "utf8");
    // Never the floating tag — that's the whole point of A3.
    expect(kit).not.toContain("codeontic@latest");
    // A concrete pin was burned in: `codeontic@<digits>[.<digits>]`. Asserting the
    // shape (not a hardcoded number) keeps this test correct across version bumps.
    expect(kit).toMatch(/codeontic@\d+(\.\d+)?\b/);
    // And it points at the strict-adapter remedy so integrators wire A2 in from day one.
    expect(kit).toContain("--strict-adapter");
    // A fresh init has nothing stale.
    expect(res.staleVersionPins).toEqual([]);
  });

  it("re-init after an upgrade WARNS that the burned pin is stale, without clobbering the file", async () => {
    // Simulate a repo that ran init on an older codeontic: an existing kit file
    // whose burned marker pins an old version, plus a repo-local edit.
    await mkdir(join(d, ".codeontic", "agent"), { recursive: true });
    const kitPath = join(d, ".codeontic/agent/setup-github-actions.md");
    const oldContent = "<!-- codeontic-pin: 0.1 -->\n# my customized workflow instructions\n";
    await writeFile(kitPath, oldContent, "utf8");

    const res = await runInit(d);

    // File was NOT clobbered — the repo's edit survives (skip-if-exists).
    expect(await readFile(kitPath, "utf8")).toBe(oldContent);
    // …but the stale pin is surfaced, naming the old pin vs. the current build.
    expect(res.skipped).toContain(".codeontic/agent/setup-github-actions.md");
    expect(res.staleVersionPins).toHaveLength(1);
    const [stale] = res.staleVersionPins;
    expect(stale?.file).toBe(".codeontic/agent/setup-github-actions.md");
    expect(stale?.pinned).toBe("0.1");
    expect(stale?.current).not.toBe("0.1");
  });

  it("re-init on a SAME-version pin reports nothing stale (no false alarm)", async () => {
    await runInit(d); // first init burns the current version
    const res = await runInit(d); // second init: same build, pin matches
    expect(res.staleVersionPins).toEqual([]);
  });

  it("the `init` CLI prints the stale-pin ⚠ warning (covers run.ts's print branch)", async () => {
    await mkdir(join(d, ".codeontic", "agent"), { recursive: true });
    await writeFile(
      join(d, ".codeontic/agent/setup-github-actions.md"),
      "<!-- codeontic-pin: 0.1 -->\n# customized\n",
      "utf8",
    );
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["init", d], io);
    expect(exitCode).toBe(0); // init never fails on a stale pin — it only warns
    expect(
      logs.some(
        (l) =>
          l.includes("⚠") && l.includes("setup-github-actions.md") && l.includes("codeontic@0.1"),
      ),
    ).toBe(true);
  });
});
