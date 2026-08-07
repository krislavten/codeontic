import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ADAPTER_INTERFACE_VERSION } from "../../adapters/types.js";
import { COMPONENT_ROLES } from "../../config/components.js";
import {
  type DetectResult,
  type WriteHostResult,
  allHostIds,
  detectHosts,
  writeAgentHost,
} from "../../hosts/registry.js";
import {
  MARKER_END,
  MARKER_START,
  type UpsertOutcome,
  upsertManagedSection,
} from "../../hosts/sections.js";
import { type SettingsMergeOutcome, mergeHooksIntoSettings } from "../../hosts/settings.js";
import {
  CODEONTIC_SKILL,
  GITHUB_ACTIONS_PIN_MARKER,
  LOOP_DISCOVERY_PARALLEL_PROMPT,
  LOOP_DISCOVERY_PROMPT,
  SETUP_PR_TEMPLATE_PROMPT,
  setupGithubActionsPrompt,
} from "../assets/agent-kit.js";

export interface InitOptions {
  hooks?: "claude" | undefined;
  agents?: string | undefined;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  managed: { file: string; outcome: UpsertOutcome }[];
  /**
   * Kit files that were SKIPPED (already exist without managed markers) but
   * whose burned-in codeontic version pin (A3) no longer matches this build.
   * Surfaced so the caller can warn; NOT auto-overwritten, because the file
   * may carry the repo's own edits.
   */
  staleVersionPins: { file: string; pinned: string; current: string }[];
  /**
   * Files that exist without managed-section markers — legacy installs that
   * cannot be auto-updated. User should delete and re-run init, or add
   * markers manually.
   */
  migrationHints: string[];
  hooksMerge?: SettingsMergeOutcome | undefined;
  agentHosts?: WriteHostResult[] | undefined;
  agentDetection?: DetectResult[] | undefined;
}

const MODEL_SUBDIRS = ["flows", "loops", "junctions", "scenarios", "baseline"];

/**
 * npm version spec a generated CI workflow should PIN codeontic to (A3), derived
 * from codeontic's own installed version. semver treats a different axis as the
 * breaking one before vs. after 1.0: on 0.x a MINOR bump may break, so pin
 * `major.minor` (`0.5` → newest 0.5.x patch, but never 0.6); from 1.0 on, MAJOR
 * is the breaking axis, so pin `major` (`1`). This is the whole point of A3:
 * `@latest` lets a future release silently change gate semantics or desync the
 * adapter's interfaceVersion under a CI that has been green for weeks. Returns
 * `null` on an unparseable version rather than a string — crucially it does NOT
 * fall back to `"latest"`, since emitting `codeontic@latest` is the exact thing
 * A3 exists to prevent; a degenerate version must fail loud upstream (see
 * `codeonticVersionPin`), never silently ship the forbidden float.
 *
 * The pattern is FULLY anchored (`^…$`) and accepts an optional semver
 * prerelease/build suffix, so a malformed string (`1.2.3.4`, `1.2.3-` with junk,
 * a bare `1.2`) reliably returns `null` instead of loosely prefix-matching. A
 * prerelease such as `0.5.0-rc.1` intentionally pins to the STABLE `0.5` line:
 * an integrator's CI should never be told to depend on our release candidate.
 */
export function versionToPinSpec(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  const major = m?.[1];
  const minor = m?.[2];
  if (major === undefined || minor === undefined) return null;
  return major === "0" ? `${major}.${minor}` : major;
}

/**
 * Read codeontic's OWN version and turn it into the pin spec. package.json sits
 * three levels above this module in BOTH layouts — `src/cli/commands/init.ts`
 * (under vitest/tsx) and `dist/cli/commands/init.js` (published; npm always
 * includes package.json regardless of the `files` allowlist) — so one
 * `import.meta.url`-relative read works in both. `init` runs as
 * `npx codeontic@X init`, so the version reading itself here IS exactly the
 * version the target should pin to.
 *
 * Throws if the version can't be determined — a codeontic whose own package.json
 * is missing/corrupt is fundamentally broken, and failing here is strictly
 * better than generating CI guidance pinned to `@latest` (which A3 forbids).
 */
async function codeonticVersionPin(): Promise<string> {
  const pkgUrl = new URL("../../../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgUrl, "utf8")) as { version?: string };
  const pin = versionToPinSpec(pkg.version ?? "");
  if (pin === null) {
    throw new Error(
      `codeontic could not determine its own version (package.json version: ${JSON.stringify(pkg.version)}); refusing to generate CI guidance that would fall back to @latest`,
    );
  }
  return pin;
}

/** Extract the burned-in pin from an existing setup-github-actions.md, or null. */
function pinnedVersionOf(kitContent: string): string | null {
  return new RegExp(`${GITHUB_ACTIONS_PIN_MARKER}\\s*(\\S+)`).exec(kitContent)?.[1] ?? null;
}

/** Check if a file's content contains managed section markers. */
function hasMarkers(content: string): boolean {
  const lines = content.split(/\r?\n/);
  return lines.some((l) => l.trim() === MARKER_START) && lines.some((l) => l.trim() === MARKER_END);
}

/**
 * The agent kit (Proposal 009): instruction files a coding agent in the target
 * repo reads and executes. init deliberately ships PROMPTS, not finished
 * workflows/templates — every repo's CI conventions differ, so the repo's own
 * agent writes the PR template section and GitHub Actions adapted to local
 * conventions, guided by these files. The GitHub Actions prompt is the one kit
 * file that varies per install: the current codeontic version is burned into its
 * pin guidance (A3) so the generated workflows pin, not float on `@latest`.
 */
function agentKit(versionPin: string): readonly { file: string; content: string }[] {
  return [
    { file: "loop-discovery.md", content: LOOP_DISCOVERY_PROMPT },
    { file: "loop-discovery-parallel.md", content: LOOP_DISCOVERY_PARALLEL_PROMPT },
    { file: "setup-pr-template.md", content: SETUP_PR_TEMPLATE_PROMPT },
    { file: "setup-github-actions.md", content: setupGithubActionsPrompt(versionPin) },
  ];
}

/**
 * What `init` prints AFTER the file list (Proposal 016 T1). `init` creates a
 * skeleton, not a model — a run that ends on `created .codeontic/model/loops/`
 * leaves the reader believing the tool did something it did not, and the
 * external-repo evaluations found every first-run user inventing their own next
 * step from scratch. So: name the next action, name the routing threshold, and
 * state the cost up front. Saying the cost is a FILTER, not a deterrent — someone who
 * won't spend an agent session on modeling should learn that here rather than
 * after a half-built model.
 *
 * Exported as data so the CLI layer only has to print it and a test can assert
 * on it without scraping stdout formatting.
 */
export const INIT_NEXT_STEPS: readonly string[] = [
  "",
  "下一步 —— 建模由你的 coding agent 来做,init 只铺了骨架目录:",
  "  1. 让它执行 /codeontic,或直接读 .claude/skills/codeontic/SKILL.md",
  "  2. 源文件 ≥ ~150 的仓库改走 .codeontic/agent/loop-discovery-parallel.md(分域并行建模)",
  "成本:完整建模是一次重活 —— 大仓要多个 agent 会话分域扫描,外加一次人工合并裁决,不是几分钟的事。",
  "产出:一张覆盖全仓主要行为的骨架图,以及建模过程逼出来的一份欠账清单;此后每次改动都能对着它核对。",
];

const MODEL_README = `# .codeontic/model/

Behavioral model source of truth (proposal 001 §4): \`flows/\` (Flow),
\`loops/\` (Loop, including embedded submachines), \`junctions/\` (Junction),
\`scenarios/\` (Scenario/GWT), \`baseline/\` (debt baseline).

A file may hold a single node or an array of nodes. Run \`codeontic check\`
to validate this directory.
`;

/**
 * Adapter skeleton README (Proposal 010 §1.2): this repo's own implementation-
 * fact extractor lives here, NOT in the codeontic package — the engine ships
 * with zero built-in adapters. `index.{js,ts}` must export a `default`
 * satisfying the `Adapter` interface (name, version, candidatePattern,
 * extractFacts, interfaceVersion — kept in lockstep with
 * ADAPTER_INTERFACE_VERSION, since the registry rejects a mismatch outright and
 * a skeleton pinned to a stale version would be dead on arrival).
 * `codeontic facts`/`reconcile`/`snapshot`/`check` discover it automatically at
 * this convention path, or via an explicit `--adapter-path`.
 */
const ADAPTER_README = `# .codeontic/adapter/

This target repo's implementation-fact extractor (Proposal 010 — open
infrastructure: no adapter ships inside the codeontic package itself).

Create \`index.js\` (or \`index.ts\`, built to \`.js\` before codeontic loads it)
exporting a \`default\` object satisfying the \`Adapter\` interface:

\`\`\`ts
export default {
  interfaceVersion: "${ADAPTER_INTERFACE_VERSION}",
  name: "my-adapter",
  version: "my-adapter-1",
  candidatePattern: "someCallShape\\\\(",
  extractFacts(filePath, content, ctx) {
    // Synchronous, and no direct \`fs\`: read other files through \`ctx.readFile\`
    // so the engine can record them and invalidate the cache when they move.
    // Return ImplementationFact[].
    return [];
  },
};
\`\`\`

\`extractFacts\` may follow a reference into another file — resolving a name
composed from a constant that lives elsewhere, say — via \`ctx.readFile(path)\`,
which returns the file's text or \`null\`. Probing paths that turn out not to
exist is fine: misses are recorded too, so a file later appearing at a probed
path correctly invalidates the cached facts.

Bump \`version\` whenever extraction logic changes — it is part of the cache key,
so a stale version serves results from the old logic.

Discovered automatically at this path by \`codeontic facts\`/\`reconcile\`/
\`snapshot\`/\`check\`, or pass \`--adapter-path <path>\` to point elsewhere.
`;

/**
 * Scopes the adapter directory to ESM (016 D6). `"private": true` keeps npm
 * from ever treating this directory as a publishable package if a workspace
 * glob happens to sweep it up — it exists purely to declare a module system.
 */
const ADAPTER_PACKAGE_JSON = `{
  "private": true,
  "type": "module"
}
`;

/**
 * Per-target config skeleton (Proposal 010 §1.2 — moved from repo root
 * `codeontic.config.json` to \`.codeontic/config.json\` for the unified
 * per-target namespace). Deliberately NOT auto-populated with real
 * guardedTables or components — that is target-repo business knowledge init
 * cannot invent. \`components\` ships as an empty array with an inline note
 * rather than being omitted: a reader who never learns the section exists gets
 * undivided reports forever and no hint why.
 *
 * The role list in that note is INTERPOLATED from \`COMPONENT_ROLES\`, not
 * retyped. A hand-copied vocabulary goes stale the moment the enum gains a
 * member, and a skeleton that documents roles the schema no longer accepts (or
 * omits ones it does) misleads exactly the reader who has nothing else to go on.
 */
const CONFIG_SKELETON = `{
  "guardedTables": {},
  "aliases": {},
  "unanalyzableExceptions": [],
  "_components": "This repo's components (deployable/runnable units). Declaring them unlocks per-partition coverage numbers and entry-type labels in views. Each entry: { id, label?, role: ${COMPONENT_ROLES.join("|")}, paths: [repo-relative prefixes] }. Left empty, those features report one undivided number rather than guessing your layout.",
  "components": []
}
`;

/**
 * Creates the \`.codeontic/\` directory skeleton in a target repo (Proposal
 * 010 — unified namespace: model, config, adapter, agent kit, and the query
 * side-channel all live under one directory instead of scattered across the
 * repo root). \`config.json\` ships as a skeleton with empty guardedTables
 * (Phase 0's T0 checks don't require it — INV-1 simply doesn't run without
 * real entries, same posture as its absence pre-010).
 *
 * Agent kit files and SKILL.md use managed sections (Proposal 013 B1) so
 * codeontic upgrades can update the managed content while preserving user
 * additions outside the markers. Legacy files without markers are left
 * untouched with a migration hint.
 */
export async function runInit(targetDir: string, options: InitOptions = {}): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const managed: InitResult["managed"] = [];
  const staleVersionPins: InitResult["staleVersionPins"] = [];
  const migrationHints: string[] = [];

  for (const sub of MODEL_SUBDIRS) {
    await mkdir(join(targetDir, ".codeontic", "model", sub), { recursive: true });
    created.push(`.codeontic/model/${sub}/`);
  }

  const readmePath = join(targetDir, ".codeontic", "model", "README.md");
  const readmeExists = await access(readmePath)
    .then(() => true)
    .catch(() => false);
  if (readmeExists) {
    skipped.push(".codeontic/model/README.md");
  } else {
    await writeFile(readmePath, MODEL_README, "utf8");
    created.push(".codeontic/model/README.md");
  }

  // Adapter skeleton (.codeontic/adapter/): idempotent skip-if-exists so a
  // repo can write its real index.js and re-run init without losing it.
  const adapterDir = join(targetDir, ".codeontic", "adapter");
  await mkdir(adapterDir, { recursive: true });
  const adapterReadmePath = join(adapterDir, "README.md");
  const adapterReadmeExists = await access(adapterReadmePath)
    .then(() => true)
    .catch(() => false);
  if (adapterReadmeExists) {
    skipped.push(".codeontic/adapter/README.md");
  } else {
    await writeFile(adapterReadmePath, ADAPTER_README, "utf8");
    created.push(".codeontic/adapter/README.md");
  }

  // The adapter is loaded with `import()`, and the skeleton README teaches ESM
  // (`export default`). Without a `type` declaration Node resolves `index.js`
  // against the TARGET repo's root package.json — a CJS (or absent) root makes
  // every adapter-loading command print MODULE_TYPELESS_PACKAGE_JSON /
  // "Cannot use import statement outside a module". A package.json scoped to
  // this directory fixes it here (016 D6) instead of asking the target repo to
  // change its root config for our sake. Skip-if-exists: a repo whose adapter
  // is a build output may have its own package.json here.
  const adapterPkgPath = join(adapterDir, "package.json");
  const adapterPkgExists = await access(adapterPkgPath)
    .then(() => true)
    .catch(() => false);
  if (adapterPkgExists) {
    skipped.push(".codeontic/adapter/package.json");
  } else {
    await writeFile(adapterPkgPath, ADAPTER_PACKAGE_JSON, "utf8");
    created.push(".codeontic/adapter/package.json");
  }

  // INV-1 config skeleton (.codeontic/config.json): idempotent skip-if-exists
  // so a repo's real guardedTables config is never clobbered by a re-run.
  const configPath = join(targetDir, ".codeontic", "config.json");
  const configExists = await access(configPath)
    .then(() => true)
    .catch(() => false);
  if (configExists) {
    skipped.push(".codeontic/config.json");
  } else {
    await writeFile(configPath, CONFIG_SKELETON, "utf8");
    created.push(".codeontic/config.json");
  }

  // Agent kit (.codeontic/agent/): managed sections (Proposal 013 B1) —
  // codeontic-managed content lives inside markers, user additions live outside.
  // Legacy files without markers are NOT auto-rewritten; a migration hint is
  // printed so the user can opt in.
  const agentDir = join(targetDir, ".codeontic", "agent");
  await mkdir(agentDir, { recursive: true });
  const versionPin = await codeonticVersionPin();
  for (const { file, content } of agentKit(versionPin)) {
    const rel = `.codeontic/agent/${file}`;
    const kitPath = join(agentDir, file);
    const existing = await readFile(kitPath, "utf8").catch(() => undefined);

    if (existing !== undefined && !hasMarkers(existing)) {
      // Legacy file without markers — do not auto-rewrite
      skipped.push(rel);
      migrationHints.push(rel);
      if (file === "setup-github-actions.md") {
        const pinned = pinnedVersionOf(existing);
        if (pinned !== null && pinned !== versionPin) {
          staleVersionPins.push({ file: rel, pinned, current: versionPin });
        }
      }
    } else {
      const result = await upsertManagedSection(kitPath, content);
      managed.push({ file: rel, outcome: result.outcome });
    }
  }

  // The unified `/codeontic` skill front door — managed sections like the kit.
  const skillDir = join(targetDir, ".claude", "skills", "codeontic");
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const skillRel = ".claude/skills/codeontic/SKILL.md";
  const skillExisting = await readFile(skillPath, "utf8").catch(() => undefined);

  if (skillExisting !== undefined && !hasMarkers(skillExisting)) {
    skipped.push(skillRel);
    migrationHints.push(skillRel);
  } else {
    const result = await upsertManagedSection(skillPath, CODEONTIC_SKILL);
    managed.push({ file: skillRel, outcome: result.outcome });
  }

  let hooksMerge: SettingsMergeOutcome | undefined;
  if (options.hooks === "claude") {
    const settingsPath = join(targetDir, ".claude", "settings.json");
    hooksMerge = await mergeHooksIntoSettings(settingsPath);
  }

  let agentHosts: WriteHostResult[] | undefined;
  let agentDetection: DetectResult[] | undefined;
  if (options.agents) {
    if (options.agents === "auto") {
      const detection = await detectHosts(targetDir);
      agentDetection = detection;
      const detected = detection.filter((d) => d.detected).map((d) => d.id);
      if (detected.length > 0) {
        agentHosts = [];
        for (const id of detected) {
          agentHosts.push(await writeAgentHost(targetDir, id, versionPin));
        }
      }
    } else {
      const ids = options.agents
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const valid = allHostIds();
      agentHosts = [];
      for (const id of ids) {
        if (!valid.includes(id)) continue;
        agentHosts.push(await writeAgentHost(targetDir, id, versionPin));
      }
    }
  }

  return {
    created,
    skipped,
    managed,
    staleVersionPins,
    migrationHints,
    hooksMerge,
    agentHosts,
    agentDetection,
  };
}
