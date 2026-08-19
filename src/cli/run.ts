import { existsSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { AdapterRegistrationError, validateAdapter } from "../adapters/registry.js";
import type { Adapter } from "../adapters/types.js";
import { runFacts } from "../facts/runner.js";
import { MARKER_END, MARKER_START } from "../hosts/sections.js";
import { loadModel } from "../loader/load-model.js";
import { startMcpServer } from "../mcp/server.js";
import { formatBacktest, formatCoverageRatio, formatModelRef } from "../query/backtest.js";
import { formatConformance } from "../query/conformance.js";
import { formatCoverage } from "../query/coverage.js";
import { type QueryCommand, runQuery } from "../query/run-query.js";
import type { ReadRepoFile } from "../validate/delegation.js";
import { inv1ViolationsFrom } from "../validate/inv1/check.js";
import { checkLoopMechanism } from "../validate/mechanism.js";
import type { Violation } from "../validate/types.js";
import { coveredFiles as modelCoveredFiles, reconcileFacts } from "../validate/unregistered.js";
import { parseFlags } from "./args.js";
import { runBacktest } from "./commands/backtest.js";
import { runCheck } from "./commands/check.js";
import { runConformance } from "./commands/conformance.js";
import { runCoverage } from "./commands/coverage.js";
import { renderDriftMarkdown, renderDriftText, runDriftReport } from "./commands/drift-report.js";
import { renderGateMarkdown, renderGateText, writeGithubSummary } from "./commands/gate-render.js";
import { runGate } from "./commands/gate.js";
import { runGraph } from "./commands/graph.js";
import { runHookPostEdit, runHookSessionStart } from "./commands/hook.js";
import { INIT_NEXT_STEPS, runInit } from "./commands/init.js";
import { runInspect } from "./commands/inspect.js";
import { runOverview } from "./commands/overview.js";
import {
  appendGithubSummary,
  renderReportMarkdown,
  renderReportText,
  runReport,
} from "./commands/report.js";
import { runSearchCli } from "./commands/search.js";
import {
  type SnapshotDrift,
  diffSnapshots,
  loadSnapshot,
  renderDrift,
  renderSnapshotSummary,
  runSnapshot,
  writeSnapshot,
} from "./commands/snapshot.js";
import { runTopology } from "./commands/topology.js";
import { runView } from "./commands/view.js";

const MANAGED_MARKER_HINT = `wrap managed content with "${MARKER_START}" / "${MARKER_END}"`;

const QUERY_COMMANDS: readonly QueryCommand[] = [
  "impact",
  "plan",
  "scenario",
  "evidence",
  "matrix",
];

export interface CliIO {
  log: (line: string) => void;
  error: (line: string) => void;
}

function formatViolation(v: Violation): string {
  // "info" never fails anything (types.ts) — kept as an explicit branch
  // (not folded into the "else ⚠" case) so a future info-severity Violation
  // routed through this formatter renders with its own "ℹ" marker instead of
  // silently reading as a warning. No current call site produces "info" here
  // today (the one that does — mechanism.ts's delegation-verified finding —
  // is formatted separately below, in the `reconcile` case); this is
  // defensive completeness for `Severity`'s third value, not dead code.
  const marker = v.severity === "error" ? "✗" : v.severity === "warning" ? "⚠" : "ℹ"; // ✗ / ⚠ / ℹ
  const loc = v.file ? ` [${v.file}]` : v.nodeId ? ` [${v.nodeId}]` : "";
  return `${marker} ${v.check}${loc}: ${v.message}`;
}

const USAGE =
  "usage: codeontic <init|check> [dir] [--adapter-path path] [--repo-root path] [--strict-anchors] [--diff base-ref] [--hooks claude]\n" +
  "       codeontic hook <post-edit|session-start> [dir]   # Claude Code hook handler (reads stdin)\n" +
  "       codeontic view <flow-id> [dir] [--validate]\n" +
  "       codeontic inspect <node-id> [dir] [--depth n]\n" +
  "       codeontic <impact|plan|scenario|evidence|matrix> <id> [dir]\n" +
  '       codeontic search "<query>" [dir]   # free-text IDF search over the model (quote multi-word queries); CLI twin of the model_search MCP tool\n' +
  "       codeontic drift-report [dir] --repo-root path --base ref [--adapter-path path] [--format github]   # topology edges this change adds/removes; both snapshots are taken by THIS process (same adapter, same config) so extractor churn cannot masquerade as architecture change; never fails\n" +
  "       codeontic report [dir] [--repo-root path] [--adapter-path path] [--format github]   # the advisory half of a CI run: reconcile + coverage + conformance in one pass, with the caveats that make them readable together; never fails\n" +
  "       codeontic gate [dir] --repo-root path [--base ref] [--strict-anchors] [--model-only] [--format github]   # CI gate: fails ONLY on errors this change introduced (--base checks out the base ref in a temp worktree and runs the identical check there, so already-broken vs newly-broken is a set difference); --repo-root is required so anchors+INV-1 really run (--model-only opts out, loudly); --format github appends to $GITHUB_STEP_SUMMARY\n" +
  "       codeontic mcp [dir]   # start the stdio MCP server\n" +
  "       codeontic facts [repo] [--adapter-path path]   # extract implementation facts (no adapter → T0-only mode)\n" +
  "       codeontic coverage [dir]   # model-side coverage: how much of the model is anchored\n" +
  "       codeontic backtest [dir] [--repo-root path] [--window N] [--ref git-ref] [--json]   # commit-side backtest (判据 A): of the last N .ts/.tsx-touching commits, how many touched a model-anchored file — distinct from `coverage` (model-side)\n" +
  "       codeontic conformance [dir] [--repo-root path] [--adapter-path path] [--strict]   # model→code report card: per-node gaps\n" +
  "       codeontic graph [dir] [--repo-root path] [--adapter-path path] [--out file]   # self-contained conformance-colored HTML of the whole model\n" +
  "       codeontic overview [dir] [--repo-root path] [--adapter-path path] [--out file]   # interactive system map: click any loop for plain-language detail\n" +
  "       codeontic topology [dir] [--repo-root path] [--adapter-path path] [--out file] [--compare-edges file.json]   # self-contained architecture diagram from declared components + fact topology hints (no model involved); --compare-edges diffs the extractor's own edges against an observed-edge file ({observableComponents?: string[], edges: {from,to}[]}, see commands/topology.ts)\n" +
  "       codeontic snapshot [dir] --repo-root path [--out file] [--drift prior.json] [--drift-json]   # T2 nightly scan artifact; --drift-json emits the drift as one JSON value on stdout (requires --drift) so a PR job can report newly added topology edges to the author (issue #38)\n" +
  "\n" +
  "--strict-anchors (check) promotes EXACTLY the two checks that can be wrong with certainty:\n" +
  "  anchor-format     malformed anchor (not `path#symbol` / `table[.column]`)   warning → ERROR\n" +
  "  anchor-existence  the anchored FILE does not exist under --repo-root        warning → ERROR\n" +
  "It deliberately leaves these as warnings, at any strictness:\n" +
  "  anchor-symbol     file exists, but no longer mentions the symbol\n" +
  "  anchor-crux       a crux / verified_by text no longer appears in its file\n" +
  "Both are whole-file TEXT matching, not an AST (see validate/symbol.ts): a legitimate\n" +
  "refactor can trip them, and a gate that cries wolf gets muted, after which it catches\n" +
  "nothing. They are not ignored, though — `conformance` CONSUMES them (Proposal 016 T6),\n" +
  "so a node whose anchors or test anchors went stale stops scoring `met`. The gate stays\n" +
  "lenient; the report card stays honest.\n" +
  "\n" +
  "adapter resolution (Proposal 010 — open infrastructure, no adapter ships in this package):\n" +
  "  1. --adapter-path <path>            explicit path to a module exporting a default Adapter\n" +
  "  2. <dir>/.codeontic/adapter/index.js  convention path, loaded if present\n" +
  '  3. neither present → "no adapter" mode: facts/reconcile/snapshot\'s INV-1+facts steps are skipped, T0 still runs\n' +
  "  --strict-adapter                    treat a missing adapter as a hard failure (non-zero exit) on\n" +
  "                                      facts/reconcile/conformance — for CI that expects an adapter and\n" +
  "                                      must not silently pass with reconciliation off. A broken adapter\n" +
  "                                      is always a hard failure; graph/overview/snapshot stay advisory.";

/**
 * `snapshot --drift-json` payload. Nested (`drift` under a `ran` discriminant)
 * rather than spread onto the top level, mirroring `backtest --json`: the same
 * shape comes back in either state, and future top-level keys cannot collide
 * with `SnapshotDrift`'s own fields.
 */
type DriftJsonPayload =
  | { ran: true; edges: DriftJsonEdgeStatus; drift: SnapshotDrift }
  | { ran: false; skippedReason: string };

/**
 * Whether `drift.addedEdges`/`removedEdges` mean anything on this run.
 *
 * REQUIRED, not optional: the whole point of this payload is a PR job reading
 * `addedEdges`, and an empty array there has three causes a bare `[]` cannot
 * tell apart — the PR genuinely added no edge, the comparison was skipped
 * (`SnapshotDrift.edgesSkippedReason`), or no adapter was resolved so nothing
 * was ever extracted. `Snapshot.topologyEdges` encodes only the first two
 * (`[]` vs `null`) and that is right for a snapshot, where "this target has no
 * adapter" is a normal empty result. For a PR gate it is a MISCONFIGURATION
 * that would otherwise report "no new edges" on every PR forever — the exact
 * silent pass issue #38's delivery exists to prevent.
 */
type DriftJsonEdgeStatus = { comparable: true } | { comparable: false; reason: string };

/**
 * Reads a `--flag value` string option. Returns `{ error }` when the flag
 * was given with no value (parseFlags then records it as boolean `true`)
 * — that's a malformed invocation (e.g. `--repo-root` as the last arg,
 * or immediately followed by another `--flag`) and must be rejected
 * loudly, not silently treated as "flag not given" (which previously let
 * `check --repo-root` with a missing value quietly skip anchor-existence
 * checking instead of erroring on the typo).
 */
function readStringFlag(
  flags: Record<string, string | boolean>,
  name: string,
): { value: string | undefined; error?: string } {
  const raw = flags[name];
  if (raw === undefined) return { value: undefined };
  if (typeof raw === "boolean") return { value: undefined, error: `--${name} requires a value` };
  // An EMPTY value is a misconfigured caller, not a default. This matters most
  // in CI, where flags are interpolated from variables: `--repo-root ""` used to
  // reach `path.resolve("")`, which is the CURRENT WORKING DIRECTORY — so a
  // pipeline with an unset variable scored a different tree than it named, and
  // every "did the caller pass this?" guard downstream saw a value that was
  // there. `--base ""` was worse: falsy, so the baseline comparison silently
  // turned itself off and every pre-existing error read as newly introduced.
  // Neither has a legitimate use; refusing here fixes both at the one place
  // where the distinction between "absent" and "empty" still exists.
  if (raw === "") {
    return {
      value: undefined,
      error: `--${name} was given an empty value (an unset CI variable?) — pass a real value or drop the flag`,
    };
  }
  return { value: raw };
}

/** Convention path a target repo's adapter module lives at, relative to targetDir. */
const ADAPTER_CONVENTION_RELATIVE_PATH = join(".codeontic", "adapter", "index.js");

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

/**
 * Outcome of resolving a target repo's adapter — a status the CLI can act on,
 * NOT just `adapter | undefined`. The three kinds map to the three things that
 * can happen and must be told apart (A1 — no silent degrade):
 *  - `loaded`  the module resolved and passed registry validation.
 *  - `absent`  neither `--adapter-path` nor the `.codeontic/adapter/` convention
 *              path was present. This is the DANGEROUS case: a CI that forgot to
 *              build/install its adapter looks identical to a repo that has none,
 *              and the old code degraded to "no adapter" mode with only a single
 *              easily-missed ⚠ line while exiting 0 (an early target repo's "82 green runs
 *              with reconciliation silently off" failure). `gateAdapter` turns
 *              this into a prominent banner and, under --strict-adapter on a
 *              gate-able command, a hard failure.
 *  - `failed`  a path WAS resolved but the module was broken (load error / no
 *              default export / interfaceVersion or sync-ness mismatch). Always
 *              a hard error on every command — you pointed at something and it
 *              doesn't work; that is never "just run without it".
 */
type AdapterStatus =
  | { kind: "loaded"; adapter: Adapter; path: string }
  | { kind: "absent" }
  | { kind: "failed"; reason: string };

/**
 * Pure resolution per Proposal 010 §1.3: `--adapter-path` (explicit, highest
 * priority) → `<targetDir>/.codeontic/adapter/index.js` (convention path, loaded
 * only if it exists) → neither → `absent`. Carries ZERO target-repo PATH
 * knowledge beyond checking for that one convention file's existence (§1.3
 * "engine never queries target-repo structure").
 *
 * The module is loaded via a plain `import()` (dynamic, but the loaded value
 * itself must be synchronous per the Adapter contract) and MUST have a `default`
 * export satisfying `Adapter`; `validateAdapter` runs the interfaceVersion +
 * sync-function checks. This function only *classifies* — it prints nothing and
 * decides no exit code; `gateAdapter` owns the banner + strict policy so the
 * "how loud / does it halt" decision lives in exactly one place.
 */
async function resolveAdapter(
  explicitPath: string | undefined,
  targetDir: string,
): Promise<AdapterStatus> {
  let modulePath: string | undefined = explicitPath;
  if (modulePath === undefined) {
    const conventionPath = join(targetDir, ADAPTER_CONVENTION_RELATIVE_PATH);
    if (await fileExists(conventionPath)) modulePath = conventionPath;
  }
  if (modulePath === undefined) return { kind: "absent" };

  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(resolvePath(modulePath)).href);
  } catch (err) {
    return {
      kind: "failed",
      reason: `failed to load adapter module "${modulePath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const adapter = mod.default as Adapter | undefined;
  if (!adapter)
    return { kind: "failed", reason: `adapter module "${modulePath}" has no default export` };
  try {
    validateAdapter(adapter);
  } catch (err) {
    if (err instanceof AdapterRegistrationError) return { kind: "failed", reason: err.message };
    throw err;
  }
  return { kind: "loaded", adapter, path: modulePath };
}

const BANNER_RULE = "─".repeat(72);

/** Positive tripwire (A1): its presence in a CI log is what makes a silently
 * adapter-less run visible by contrast. Absence of this line == no adapter. */
function loadedLine(a: Adapter, path: string): string {
  return `adapter "${a.name}" v${a.version} loaded from ${path}`;
}

/**
 * Prominent "reconciliation is OFF" banner (A1). `gateable` decides whether the
 * --strict-adapter remedy is even offered: on read-only/advisory commands
 * (graph/overview/snapshot) --strict-adapter cannot force a non-zero exit — they
 * are documented to always exit 0 — so pointing the reader at it would be a lie.
 */
function absentBanner(gateable: boolean): string {
  const remedy = gateable
    ? "   Add an adapter (`codeontic init`) or pass --strict-adapter to fail CI on this."
    : "   Add an adapter (`codeontic init`) to enable them.";
  return [
    BANNER_RULE,
    "⚠  NO ADAPTER — implementation reconciliation is OFF",
    "   Looked for --adapter-path and .codeontic/adapter/index.js; found neither.",
    "   Queue/fact checks are skipped; this run cannot detect implementation drift.",
    remedy,
    BANNER_RULE,
  ].join("\n");
}

const ABSENT_STRICT_BANNER = [
  BANNER_RULE,
  "✗  NO ADAPTER (--strict-adapter set) — required but none resolved",
  "   Looked for --adapter-path and .codeontic/adapter/index.js; found neither.",
  "   This is a hard failure because --strict-adapter is set.",
  BANNER_RULE,
].join("\n");

function failedBanner(reason: string): string {
  return [BANNER_RULE, "✗  ADAPTER FAILED TO LOAD", `   ${reason}`, BANNER_RULE].join("\n");
}

/**
 * Resolve + report the adapter in one call, returning either a usable
 * `{ adapter? }` (adapter present, or absent-but-continue) or `{ halt }` with an
 * exit code the command must return immediately. This is the ONE place adapter
 * status becomes visible (A1) and the ONE place --strict-adapter is enforced
 * (A2), so all six fact-consuming commands share identical semantics.
 *
 * `gateable` = "may --strict-adapter turn ABSENCE into a hard failure here?".
 * True for facts/reconcile/conformance (already gate-able commands — they carry
 * a --strict flag and are meant to be CI gates). False for graph/overview/
 * snapshot, whose contract is "always exit 0 / never a PR gate" (run.ts cases
 * below; snapshot per 001 §6) — they still show the banner but never halt on
 * absence. A *broken* adapter (`failed`) halts everywhere regardless: that was
 * already true on all six and is not a policy this flag gets to relax.
 */
async function gateAdapter(
  flags: Record<string, string | boolean>,
  targetDir: string,
  io: CliIO,
  gateable: boolean,
): Promise<{ adapter?: Adapter } | { halt: number }> {
  const f = readStringFlag(flags, "adapter-path");
  if (f.error) {
    // CLI misuse (e.g. `--adapter-path` as the last token) — keep the usage hint.
    io.error(`${f.error}. ${USAGE}`);
    return { halt: 1 };
  }

  const status = await resolveAdapter(f.value, targetDir);
  switch (status.kind) {
    case "loaded":
      io.log(loadedLine(status.adapter, status.path));
      return { adapter: status.adapter };
    case "failed":
      io.error(failedBanner(status.reason));
      return { halt: 1 };
    default: {
      // absent
      if (gateable && flags["strict-adapter"] === true) {
        io.error(ABSENT_STRICT_BANNER);
        return { halt: 1 };
      }
      io.log(absentBanner(gateable));
      return {};
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream: Readable = process.stdin;
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
    if (stream.readableEnded) resolve("");
  });
}

/**
 * Core dispatch, factored out of the process entry point so tests can
 * drive it in-process (real filesystem via temp dirs, no subprocess
 * spawning, no mocking process.argv/stdout).
 */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);
  const targetDir = positionals[0] ?? process.cwd();

  switch (command) {
    case "init": {
      const hooksFlag = readStringFlag(flags, "hooks");
      const agentsFlag = readStringFlag(flags, "agents");
      for (const f of [hooksFlag, agentsFlag]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      const result = await runInit(targetDir, {
        hooks: hooksFlag.value === "claude" ? "claude" : undefined,
        agents: agentsFlag.value,
      });
      for (const c of result.created) io.log(`created ${c}`);
      for (const s of result.skipped) io.log(`skipped ${s} (already exists)`);
      for (const m of result.managed) io.log(`managed ${m.file} → ${m.outcome}`);
      for (const p of result.staleVersionPins) {
        io.log(
          `⚠ ${p.file} is pinned to codeontic@${p.pinned} but this build is @${p.current} — kept your file (edits preserved); update the pin by hand if you're upgrading its CI.`,
        );
      }
      for (const h of result.migrationHints) {
        io.log(
          `⚠ ${h} exists without managed-section markers — delete the file and re-run init, or add markers manually (${MANAGED_MARKER_HINT})`,
        );
      }
      if (result.hooksMerge) {
        io.log(`hooks .claude/settings.json → ${result.hooksMerge}`);
      }
      if (result.agentDetection) {
        for (const d of result.agentDetection) {
          io.log(`agent ${d.id}: ${d.detected ? "detected" : "not detected"}`);
        }
      }
      if (result.agentHosts) {
        for (const h of result.agentHosts) {
          io.log(
            `agent ${h.hostId}: instruction → ${h.instruction}${h.mcp ? `, mcp → ${h.mcp}` : ""}`,
          );
          // `skipped-modified` means we found local edits and refused to
          // clobber them. Say so loudly with the recovery step — a bare
          // status word here would read as "nothing to do" and the user would
          // never learn their host file is now stale.
          if (h.instruction === "skipped-modified") {
            io.log(
              `  ⚠ ${h.hostId}: kept your edited file (not overwritten) — delete it and re-run init to take the current version`,
            );
          }
        }
      }
      // The exit guidance goes LAST, after every per-file line, so the reader's
      // final screenful is "what do I do now" rather than the file list (016 T1).
      for (const line of INIT_NEXT_STEPS) io.log(line);
      return 0;
    }
    case "hook": {
      // positionals[0] is the EVENT, not the target dir — the shared
      // `targetDir` above would resolve to a "./post-edit" directory.
      const event = positionals[0];
      const hookDir = positionals[1] ?? process.cwd();
      if (event !== "post-edit" && event !== "session-start") {
        io.error(`unknown hook event "${event ?? ""}". Supported: post-edit, session-start`);
        return 0;
      }
      let stdin = "";
      try {
        stdin = await readStdin();
      } catch {
        /* empty stdin is fine */
      }
      try {
        if (event === "post-edit") {
          const context = await runHookPostEdit(hookDir, stdin);
          // PostToolUse plain stdout only reaches the transcript view — the
          // JSON envelope's additionalContext is what Claude actually sees.
          if (context) {
            io.log(
              JSON.stringify({
                hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
              }),
            );
          }
        } else {
          // SessionStart stdout IS injected into context directly.
          const context = await runHookSessionStart(hookDir);
          if (context) io.log(context);
        }
      } catch (err) {
        io.error(`[codeontic hook] ${err instanceof Error ? err.message : String(err)}`);
      }
      return 0;
    }
    case "check": {
      const repoRootFlag = readStringFlag(flags, "repo-root");
      if (repoRootFlag.error) {
        io.error(`${repoRootFlag.error}. ${USAGE}`);
        return 1;
      }
      const repoRoot = repoRootFlag.value;
      const strictAnchorExistence = flags["strict-anchors"] === true;
      const diffFlag = readStringFlag(flags, "diff");
      if (diffFlag.error) {
        io.error(`${diffFlag.error}. ${USAGE}`);
        return 1;
      }
      const { t0, inv1, inv1ConfigError, diff, baselineViolations } = await runCheck(targetDir, {
        repoRoot,
        strictAnchorExistence,
        diffBase: diffFlag.value,
      });

      const violations = [...t0.violations];
      if (baselineViolations) violations.push(...baselineViolations);
      if (inv1) violations.push(...inv1ViolationsFrom(inv1));
      for (const v of violations) io.log(formatViolation(v));

      if (diff) {
        if (!diff.changed) {
          io.log(
            `⚠ --diff ${diff.baseRef}: could not resolve diff (bad ref / not git) — full scan`,
          );
        } else {
          io.log(
            `--diff ${diff.baseRef}: ${diff.changed.length} changed file(s), ${diff.affected.length} affected model node(s)${diff.incremental ? " (INV-1 incremental)" : ""}`,
          );
          for (const a of diff.affected)
            io.log(`  affects ${a.nodeId} (${a.kind}) via ${a.anchor}`);
        }
      }

      if (inv1ConfigError) io.error(`✗ inv1-config: ${inv1ConfigError}`);
      if (inv1) {
        if (!inv1.ran) {
          io.log(`⚠ INV-1 scan skipped: ${inv1.skippedReason}`);
        } else {
          const byVerdict = inv1.writePoints.reduce<Record<string, number>>((acc, w) => {
            acc[w.verdict] = (acc[w.verdict] ?? 0) + 1;
            return acc;
          }, {});
          io.log(
            `INV-1 scan: ${inv1.filesScanned}/${inv1.candidateFiles} candidate file(s), ` +
              `${byVerdict.allowed ?? 0} allowed / ${byVerdict.violation ?? 0} violation(s) / ${byVerdict.unanalyzable ?? 0} unanalyzable, ` +
              `${inv1.timingMs.toFixed(0)}ms`,
          );
        }
      }

      const errorCount = violations.filter((v) => v.severity === "error").length;
      const warningCount = violations.length - errorCount;
      const ok = errorCount === 0 && !inv1ConfigError;
      io.log(
        ok
          ? `T0 passed (${warningCount} warning(s))`
          : `T0 failed (${errorCount} error(s), ${warningCount} warning(s))`,
      );
      return ok ? 0 : 1;
    }
    case "view": {
      // Unlike init/check, positionals[0] here is the required
      // <flow-id>, not the target dir — the shared `targetDir` computed
      // above (which assumes positionals[0] is a dir) doesn't apply.
      const flowId = positionals[0];
      if (!flowId) {
        io.error(`missing <flow-id>. ${USAGE}`);
        return 1;
      }
      const viewTargetDir = positionals[1] ?? process.cwd();
      const validate = flags.validate === true;

      let result: Awaited<ReturnType<typeof runView>>;
      try {
        result = await runView(viewTargetDir, flowId, { validate });
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        return 1;
      }

      io.log(`wrote ${result.outputPath}`);
      if (!result.validation) return 0;
      if (result.validation.status === "valid") {
        io.log("mermaid validation: ok");
        return 0;
      }
      if (result.validation.status === "unavailable") {
        io.log(`⚠ mermaid validation skipped: ${result.validation.reason}`);
        return 0;
      }
      io.log(`✗ mermaid validation failed: ${result.validation.error}`);
      return 1;
    }
    case "inspect": {
      // positionals[0] is the required <node-id>, not the target dir.
      const nodeId = positionals[0];
      if (!nodeId) {
        io.error(`missing <node-id>. ${USAGE}`);
        return 1;
      }
      const inspectTargetDir = positionals[1] ?? process.cwd();
      const depthFlag = readStringFlag(flags, "depth");
      if (depthFlag.error) {
        io.error(`${depthFlag.error}. ${USAGE}`);
        return 1;
      }
      let depth: number | undefined;
      if (depthFlag.value !== undefined) {
        depth = Number(depthFlag.value);
        if (!Number.isInteger(depth) || depth < 0) {
          io.error(`--depth must be a non-negative integer, got "${depthFlag.value}". ${USAGE}`);
          return 1;
        }
      }

      let result: Awaited<ReturnType<typeof runInspect>>;
      try {
        result = await runInspect(inspectTargetDir, nodeId, depth === undefined ? {} : { depth });
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        return 1;
      }

      if (result.staleWarning) io.log(`⚠ ${result.staleWarning}`);
      io.log(result.summary);
      io.log(`wrote ${result.outputPath}`);
      return 0;
    }
    case "drift-report": {
      const driftTargetDir = positionals[0] ?? process.cwd();
      const driftRepoRoot = readStringFlag(flags, "repo-root");
      const driftBase = readStringFlag(flags, "base");
      const driftFormat = readStringFlag(flags, "format");
      for (const f of [driftRepoRoot, driftBase, driftFormat]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      if (!driftRepoRoot.value || !driftBase.value) {
        io.error(`drift-report requires --repo-root <path> and --base <ref>. ${USAGE}`);
        return 1;
      }
      if (driftFormat.value !== undefined && driftFormat.value !== "github") {
        io.error(`--format must be "github" (got "${driftFormat.value}"). ${USAGE}`);
        return 1;
      }
      // `gateable: true` so a BROKEN adapter is loud rather than silently
      // producing an empty edge set (which would read as "no new edges"). Its
      // halt is converted into a stated non-result instead of an exit code:
      // this command is documented — in its usage line and its changeset — as
      // never failing the caller, and a step that sometimes exits 1 anyway is
      // worse than either contract, because the workflow around it is written
      // for the promise, not the exception.
      const driftReportAdapter = await gateAdapter(flags, driftRepoRoot.value, io, true);
      // Same reasoning as `report` above: an advisory step that throws turns a
      // reading into a red build. A failure becomes a stated non-result.
      let driftResult: Awaited<ReturnType<typeof runDriftReport>>;
      if ("halt" in driftReportAdapter) {
        driftResult = {
          ran: false,
          reason: "适配器没能加载（上面已打印原因）——没有事实提取器就没有边可比",
        };
      } else {
        try {
          driftResult = await runDriftReport(driftTargetDir, {
            repoRoot: resolvePath(driftRepoRoot.value),
            base: driftBase.value,
            ...(driftReportAdapter.adapter ? { adapter: driftReportAdapter.adapter } : {}),
          });
        } catch (err) {
          driftResult = {
            ran: false,
            reason: `drift-report 抛错：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      io.log(renderDriftText(driftResult));
      if (driftFormat.value === "github") {
        const markdown = renderDriftMarkdown(driftResult);
        if (!(await appendGithubSummary(markdown))) io.log(markdown);
      }
      // Advisory: a reading about architecture never fails the caller. When the
      // comparison could not run, the summary says so in words — that state is
      // reported, not swallowed, and not turned into a red build either.
      return 0;
    }
    case "report": {
      // Composition, not reimplementation: each section runs the very command
      // it names, through this same dispatcher with a capturing io. There is no
      // second code path to drift from the first.
      const reportTargetDir = positionals[0] ?? process.cwd();
      const reportRepoRoot = readStringFlag(flags, "repo-root");
      const reportAdapter = readStringFlag(flags, "adapter-path");
      const reportFormat = readStringFlag(flags, "format");
      for (const f of [reportRepoRoot, reportAdapter, reportFormat]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      if (reportFormat.value !== undefined && reportFormat.value !== "github") {
        io.error(`--format must be "github" (got "${reportFormat.value}"). ${USAGE}`);
        return 1;
      }
      // "never fails" has to survive an exception too, not just a non-zero
      // exit: an unparseable model made `report` die with zero output, which is
      // the one thing an advisory step must never do — the reader cannot tell
      // "nothing to report" from "this never ran".
      let report: Awaited<ReturnType<typeof runReport>>;
      try {
        report = await runReport(
          reportTargetDir,
          {
            ...(reportRepoRoot.value === undefined ? {} : { repoRoot: reportRepoRoot.value }),
            ...(reportAdapter.value === undefined ? {} : { adapterPath: reportAdapter.value }),
            ...(flags["no-cache"] === true ? { noCache: true } : {}),
          },
          (args, captureIo) => run(args, captureIo),
        );
      } catch (err) {
        io.error(
          `⚠ report 未能产出：${err instanceof Error ? err.message : String(err)} —— 这是管线故障，不是「没查出问题」。`,
        );
        return 0;
      }
      io.log(renderReportText(report));
      if (reportFormat.value === "github") {
        const markdown = renderReportMarkdown(report);
        if (!(await appendGithubSummary(markdown))) io.log(markdown);
      }
      // Advisory by construction: a reading never fails the caller.
      return 0;
    }
    case "gate": {
      // The CI entry point. Everything a workflow used to hand-roll around
      // `check` — base comparison, cause attribution, the step summary, the
      // exit code — is a return value here; see commands/gate.ts on why.
      const gateTargetDir = resolvePath(positionals[0] ?? process.cwd());
      const gateRepoRoot = readStringFlag(flags, "repo-root");
      const gateBase = readStringFlag(flags, "base");
      const gateFormat = readStringFlag(flags, "format");
      for (const f of [gateRepoRoot, gateBase, gateFormat]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      if (gateFormat.value !== undefined && gateFormat.value !== "github") {
        io.error(`--format must be "github" (got "${gateFormat.value}"). ${USAGE}`);
        return 1;
      }
      // `gate` is the CI entry point, so a partial run must not look like a
      // pass. Without a repo root, anchor-existence and INV-1 do not run at all
      // and the remaining model-only checks happily report "no model errors" —
      // a green build that checked half of what its name implies. Requiring the
      // flag makes the complete run the default; `--model-only` is the way to
      // ask for the partial one, and it says so in the output.
      if (gateRepoRoot.value === undefined && flags["model-only"] !== true) {
        io.error(
          `gate needs --repo-root <repo>: without it anchor-existence and INV-1 do not run, and the result would read as "clean" while half the gate never executed. Pass --model-only if a model-only check is what you want. ${USAGE}`,
        );
        return 1;
      }
      let gate: Awaited<ReturnType<typeof runGate>>;
      try {
        gate = await runGate(gateTargetDir, {
          repoRoot: gateRepoRoot.value === undefined ? undefined : resolvePath(gateRepoRoot.value),
          ...(flags["strict-anchors"] === true ? { strictAnchorExistence: true } : {}),
          ...(gateBase.value === undefined ? {} : { base: gateBase.value }),
        });
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
      io.log(renderGateText(gate));
      if (gateFormat.value === "github") {
        const markdown = renderGateMarkdown(gate);
        if (!(await writeGithubSummary(markdown))) {
          // No $GITHUB_STEP_SUMMARY (running locally): print the markdown rather
          // than silently producing nothing — the caller asked for it.
          io.log(markdown);
        }
      }
      return gate.exitCode;
    }
    case "search": {
      // positionals[0] is the required query string, positionals[1] the target
      // dir — same shape as inspect. A third positional almost always means an
      // unquoted multi-word query, so name that mistake instead of a generic
      // usage error (silently joining the words instead would make a query that
      // happens to end in a directory name ambiguous).
      const query = positionals[0];
      if (!query) {
        io.error(`missing <query> for \`search\`. ${USAGE}`);
        return 1;
      }
      // `search <query> <dir>` and an unquoted two-word query are the SAME argv,
      // so the trailing argument has to be classified. The only signal that
      // actually distinguishes them is whether it carries a model: a directory
      // holding `.codeontic/model` is what "target dir" MEANS, and nothing else
      // can be searched. Bare existence is not enough — `search session docs`
      // in a repo that has a model-less `docs/` would sail through and surface
      // `model directory "docs/.codeontic/model" is not found — run "codeontic
      // init"`, telling the user to initialize a directory they never meant to
      // name. Where the signal is absent, say so and name BOTH readings instead
      // of silently picking one.
      const isSearchableDir = (p: string): boolean =>
        existsSync(join(p, ".codeontic", "model")) &&
        statSync(join(p, ".codeontic", "model")).isDirectory();
      if (positionals.length > 2) {
        // Same predicate as below, so the suggested command is copy-paste
        // runnable: a trailing arg that isn't a searchable dir belongs inside
        // the quoted query, not after it.
        const last = positionals[positionals.length - 1] as string;
        const lastIsDir = isSearchableDir(last);
        const exampleQuery = (lastIsDir ? positionals.slice(0, -1) : positionals).join(" ");
        io.error(
          `search takes one query and an optional dir, got ${positionals.length} arguments — quote a multi-word query: codeontic search "${exampleQuery}"${lastIsDir ? ` ${last}` : " [dir]"}`,
        );
        return 1;
      }
      // Exactly two positionals — the most common unquoted form
      // (`search session revive`) lands here, as does the documented
      // `search auth ../other-repo`.
      if (positionals[1] !== undefined && !isSearchableDir(positionals[1])) {
        const reason = existsSync(positionals[1])
          ? `"${positionals[1]}" has no .codeontic/model`
          : `"${positionals[1]}" does not exist`;
        io.error(
          `${reason}, so it can't be the target dir — if it's part of the query, quote it: codeontic search "${query} ${positionals[1]}" [dir]; if you did mean that dir, run \`codeontic init\` there first`,
        );
        return 1;
      }
      const searchTargetDir = positionals[1] ?? process.cwd();
      let result: Awaited<ReturnType<typeof runSearchCli>>;
      try {
        result = await runSearchCli(searchTargetDir, query);
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
      if (result.staleWarning) io.log(`⚠ ${result.staleWarning}`);
      io.log(result.summary);
      io.log(`wrote ${result.outputPath}`);
      return 0;
    }
    case "mcp": {
      // Long-lived stdio server: it owns stdout for the JSON-RPC protocol, so
      // nothing else may write there. targetDir is positionals[0] (the dir with
      // model/), defaulting to cwd.
      const mcpTargetDir = positionals[0] ?? process.cwd();
      await startMcpServer(mcpTargetDir);
      return 0; // returns when the transport closes
    }
    case "facts": {
      // Extract implementation facts from a target repo (positionals[0] = repo
      // root, defaulting to cwd). `--no-cache` disables the B3 content cache.
      // Adapter resolution: --adapter-path, else <repo>/.codeontic/adapter/, else
      // "no adapter" mode (no facts to extract — this repo carries none itself).
      const repo = positionals[0] ?? process.cwd();
      const factsAdapter = await gateAdapter(flags, repo, io, /* gateable */ true);
      if ("halt" in factsAdapter) return factsAdapter.halt;
      if (!factsAdapter.adapter) {
        // absent (non-strict): banner already printed; nothing to extract.
        return 0;
      }
      const result = await runFacts(repo, {
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
        adapter: factsAdapter.adapter,
      });
      if (!result.ran) {
        io.log(`⚠ facts extraction skipped: ${result.skippedReason}`);
        return 0;
      }
      const bySignal: Record<string, typeof result.facts> = {};
      for (const f of result.facts) {
        const list = bySignal[f.signal] ?? [];
        list.push(f);
        bySignal[f.signal] = list;
      }
      for (const [signal, list] of Object.entries(bySignal)) {
        io.log(`${signal} (${list.length}):`);
        for (const f of list) {
          const detail = f.detail ? `  [${f.detail}${f.unanalyzable ? ", unanalyzable" : ""}]` : "";
          io.log(`  ${f.name}  ${f.filePath}:${f.line}${detail}`);
        }
      }
      io.log(
        `extracted ${result.facts.length} fact(s) from ${result.filesScanned}/${result.candidateFiles} candidate file(s), ${result.timingMs.toFixed(0)}ms`,
      );
      return 0;
    }
    case "reconcile": {
      // C2 T1 (advisory): which extracted facts no model node registers.
      // `codeontic reconcile <model-dir> --repo-root <repo>`. Exits 0 always
      // (T1 is report-tier until C3 promotes it); `--strict` flips unregistered
      // facts into a non-zero exit for opt-in local use.
      const repoRootFlag = readStringFlag(flags, "repo-root");
      if (repoRootFlag.error || !repoRootFlag.value) {
        io.error(`reconcile needs --repo-root <repo>. ${USAGE}`);
        return 1;
      }
      const reconcileAdapter = await gateAdapter(
        flags,
        repoRootFlag.value,
        io,
        /* gateable */ true,
      );
      if ("halt" in reconcileAdapter) return reconcileAdapter.halt;
      if (!reconcileAdapter.adapter) {
        // absent (non-strict): banner already printed; nothing to reconcile against.
        return 0;
      }
      const model = await loadModel(`${targetDir}/.codeontic/model`);
      const factsResult = await runFacts(repoRootFlag.value, {
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
        adapter: reconcileAdapter.adapter,
        // The model's own anchors widen the scan set. A file the model points at
        // is a declared part of a loop, so it gets extracted even when the
        // adapter's `candidatePattern` doesn't match it — the case where the
        // authoritative literal lives in a file carrying no call site. Non-`.ts`
        // anchors (db tables, spec docs) are dropped by runFacts.
        extraCandidates: [...modelCoveredFiles(model.graph)],
      });
      if (!factsResult.ran) {
        io.log(`⚠ reconcile skipped: ${factsResult.skippedReason}`);
        return 0;
      }
      // Shared by both delegation-aware call sites below: `reconcileFacts`'
      // one-hop-into-registered check and `checkLoopMechanism`'s one-hop
      // mechanism-evidence check are independent features that happen to
      // both need "read a file from the target repo".
      const readRepoFile: ReadRepoFile = (rel) => {
        try {
          return readFileSync(join(repoRootFlag.value as string, rel), "utf8");
        } catch {
          return null;
        }
      };
      // `--no-follow-delegation`: the two-sided check this exists for is
      // "turn it off, see the warning reappear; turn it on, see it vanish
      // again" — both `reconcileFacts` and `checkLoopMechanism` read the same
      // flag so a single run compares apples to apples.
      // `!== true` (not `!== undefined`) matches every other boolean flag in
      // this file: `parseFlags` gives a bare `--flag` the value `true`, and
      // anything else means unset.
      //
      // This comment used to add "or `--flag value` swallowing a stray token",
      // and called that an established convention. It was not a convention, it
      // was the bug: a swallowed token made the flag read as unset AND removed
      // a positional. `parseFlags` now knows which flags take no value (see
      // BOOLEAN_FLAGS there), so that case cannot arise.
      const followDelegation = flags["no-follow-delegation"] !== true;
      // Scope reconciliation to the signal kinds it is ABOUT. An adapter that
      // also emits facts of a different nature (topology edges, dependency
      // clients) declares `reconcilableSignalKinds`; undeclared means "all",
      // which is what every pre-existing adapter meant.
      // Measured on a real target: the unregistered list went 6 → 69 the
      // moment the adapter started emitting topology hints, because none of
      // those are things a Loop is supposed to register. Left unscoped, the
      // one number the model is steered by becomes 90% noise.
      const reconcilableKinds = reconcileAdapter.adapter?.reconcilableSignalKinds;
      // Branch on the DECLARATION, never on an empty set standing in for
      // "all": `new Set(kinds ?? [])` would make "undeclared" and "declared
      // as []" the same object, and the two mean opposite things here
      // (undeclared = everything reconciles; declared-empty = nothing does).
      const inScope =
        reconcilableKinds === undefined
          ? factsResult.facts
          : ((kinds) => factsResult.facts.filter((f) => kinds.has(f.signal)))(
              new Set(reconcilableKinds),
            );
      const outOfScopeCount = factsResult.facts.length - inScope.length;
      const {
        registered,
        dormantSuppressed,
        unregistered,
        coveredFiles,
        unmatchedConsumedQueues,
        delegationHits,
      } = reconcileFacts(
        inScope,
        model.graph,
        reconcileAdapter.adapter?.nameMatchableSignalKinds ?? [],
        { readFile: readRepoFile, followDelegation },
      );
      for (const f of unregistered)
        io.log(`⚠ unregistered ${f.signal}: ${f.name}  ${f.filePath}:${f.line}`);
      for (const f of dormantSuppressed)
        io.log(`· dormant-suppressed ${f.signal}: ${f.name}  ${f.filePath}:${f.line}`);
      // "Resolved but registered nothing" still prints — see `DelegationHit`
      // doc for why 0 is not filtered out (it is the "ran, found nothing"
      // signal, distinct from "did not run" — the whole point of this field).
      for (const h of delegationHits)
        io.log(
          `· delegation ${h.loopId}: ${h.anchor} → ${h.target} (${h.registeredFactCount} fact(s) registered)`,
        );
      // Two causes, not one: the declaration is wrong, OR the extractor never
      // reached the code that defines the name. The old wording asserted the
      // first ("typo/stale?") and sent people to edit a model that was right.
      for (const u of unmatchedConsumedQueues) {
        io.log(
          `⚠ unmatched consumes_queues: "${u.queue}" declared by ${u.declaredBy.join(", ")}, no extracted queue matches`,
        );
        const scanned = `${factsResult.filesScanned}/${factsResult.candidateFiles} file(s) scanned`;
        io.log(
          `    → either the name is stale/misspelled in the model, or extraction didn't reach it (${scanned}; check the declaring loop's anchors)`,
        );
      }
      // Anchors can be present and correct while the behaviour they describe has
      // moved out from under them (a god-file split leaves a delegating wrapper).
      // Only the facts can see that, so the mechanism check runs here rather than
      // in T0 — and only for loops that opted in by declaring one.
      const mechanismViolations = checkLoopMechanism(model.graph, factsResult.facts, {
        readFile: readRepoFile,
        followDelegation,
      });
      // Severity-aware marker, but the same "⚠ ${check}: ${message}" shape
      // this line always had — deliberately NOT switched to `formatViolation`
      // (which would also prepend a `[nodeId]` this output never carried) to
      // keep this diff to the one thing it's here for: telling an "info"
      // (delegation-verified, never fails anything) apart from a real "⚠".
      for (const v of mechanismViolations) {
        const marker = v.severity === "info" ? "ℹ" : "⚠";
        io.log(`${marker} ${v.check}: ${v.message}`);
      }

      // Denominator is the IN-SCOPE facts, so the percentage answers "of the
      // things that should be registered, how many aren't" rather than being
      // diluted by facts reconciliation was never about.
      const total = inScope.length;
      const pct = total === 0 ? 0 : Math.round((unregistered.length / total) * 100);
      const dormantNote =
        dormantSuppressed.length > 0 ? `, ${dormantSuppressed.length} dormant-suppressed` : "";
      // Narrowing the scope must never be silent — an unexplained drop in the
      // denominator reads exactly like facts going missing, which is the
      // failure mode this whole check exists to catch.
      if (outOfScopeCount > 0) {
        io.log(
          `· ${outOfScopeCount} fact(s) outside reconciliation scope (adapter declares reconcilableSignalKinds=[${(reconcilableKinds ?? []).join(", ")}]) — still extracted, just not things a model node registers`,
        );
      }
      // registered + dormantSuppressed + unregistered === total (disjoint).
      io.log(
        `reconcile: ${registered.length}/${total} fact(s) registered${dormantNote}, ${unregistered.length} unregistered (${pct}%), ` +
          `${coveredFiles.length} model-covered file(s)`,
      );
      return flags.strict === true && unregistered.length > 0 ? 1 : 0;
    }
    case "coverage": {
      // Model-side coverage (advisory, always exit 0). The counterweight to
      // `reconcile`: that command measures code→model, this one measures how
      // much of the model is itself anchored. A report carrying only reconcile
      // reads as "covered" on a model that only covers one flow.
      const result = await runCoverage(targetDir);
      if (!result.ran) {
        io.log(`⚠ coverage skipped: ${result.skippedReason}`);
        return 0;
      }
      for (const line of formatCoverage(result.coverage)) io.log(line);
      return 0;
    }
    case "backtest": {
      // Commit-side backtest (判据 A, issue #23 阶段1 PR1): of the last N
      // .ts/.tsx-touching commits, how many touched a model-anchored file?
      // The counterweight to `coverage` above (which measures the MODEL, not
      // commits) — advisory/read-only, always exit 0, same tier as coverage.
      const repoRootFlag = readStringFlag(flags, "repo-root");
      const refFlag = readStringFlag(flags, "ref");
      const windowFlag = readStringFlag(flags, "window");
      for (const f of [repoRootFlag, refFlag, windowFlag]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      let window: number | undefined;
      if (windowFlag.value !== undefined) {
        window = Number(windowFlag.value);
        if (!Number.isInteger(window) || window <= 0) {
          io.error(`--window must be a positive integer, got "${windowFlag.value}". ${USAGE}`);
          return 1;
        }
      }

      const result = await runBacktest(targetDir, {
        repoRoot: repoRootFlag.value,
        ref: refFlag.value,
        ...(window !== undefined ? { window } : {}),
      });

      // `--json` ALWAYS emits exactly one JSON value on stdout, in EITHER
      // ran state — never text + JSON mixed on the same stream (that would
      // break any consumer piping this into `JSON.parse`), and always the
      // SAME nested shape (`{ran, report?, coverageRatio?, modelRef?}`,
      // mirroring BacktestResult) rather than spreading `report`'s fields
      // onto the top level, which would collide with future top-level keys.
      if (flags.json === true) {
        io.log(
          JSON.stringify(
            result.ran
              ? {
                  ran: true,
                  report: result.report,
                  coverageRatio: result.coverageRatio,
                  modelRef: result.modelRef,
                }
              : {
                  ran: false,
                  skippedReason: result.skippedReason,
                  coverageRatio: result.coverageRatio,
                  modelRef: result.modelRef,
                },
            null,
            2,
          ),
        );
        return 0;
      }

      if (!result.ran) {
        io.log(`⚠ backtest skipped: ${result.skippedReason}`);
        // 判据 C only needs the model, not git — it survives a git-side
        // failure (bad ref, not a checkout, broken components config) and is
        // still worth printing even though A (above) couldn't run.
        if (result.coverageRatio) {
          if (result.modelRef) io.log(`  ${formatModelRef(result.modelRef)}`);
          for (const line of formatCoverageRatio(result.coverageRatio)) io.log(line);
        }
        return 0;
      }
      for (const line of formatBacktest(result.report, result.modelRef)) io.log(line);
      for (const line of formatCoverageRatio(result.coverageRatio)) io.log(line);
      return 0;
    }
    case "conformance": {
      // Model→code report card (advisory, exit 0 by default). Both --repo-root
      // and an adapter are OPTIONAL: without --repo-root, anchors/tests are
      // trusted structurally (a loud banner says so); without an adapter, queue
      // obligations are not checked. `--strict` flips any gap into a non-zero
      // exit for opt-in local use, mirroring `reconcile --strict`.
      const repoRootFlag = readStringFlag(flags, "repo-root");
      if (repoRootFlag.error) {
        io.error(`${repoRootFlag.error}. ${USAGE}`);
        return 1;
      }
      const conformanceAdapter = await gateAdapter(
        flags,
        repoRootFlag.value ?? targetDir,
        io,
        /* gateable */ true,
      );
      if ("halt" in conformanceAdapter) return conformanceAdapter.halt;

      const result = await runConformance(targetDir, {
        repoRoot: repoRootFlag.value,
        ...(conformanceAdapter.adapter ? { adapter: conformanceAdapter.adapter } : {}),
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
      });
      if (!result.ran) {
        io.log(`⚠ conformance skipped: ${result.skippedReason}`);
        return 0;
      }
      if (result.factsSkipped) {
        io.log(`⚠ queue check skipped: ${result.factsSkipped}`);
      }
      for (const line of formatConformance(result.conformance)) io.log(line);
      return flags.strict === true && result.conformance.gaps.length > 0 ? 1 : 0;
    }
    case "graph": {
      // Self-contained, conformance-colored HTML of the whole model, written to
      // the gitignored ws/ side-channel. Advisory/read-only: always exit 0.
      const repoRootFlag = readStringFlag(flags, "repo-root");
      const outFlag = readStringFlag(flags, "out");
      for (const f of [repoRootFlag, outFlag]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      const graphAdapter = await gateAdapter(
        flags,
        repoRootFlag.value ?? targetDir,
        io,
        /* gateable */ false, // graph is advisory/read-only: always exit 0 (below)
      );
      if ("halt" in graphAdapter) return graphAdapter.halt;

      const result = await runGraph(targetDir, {
        repoRoot: repoRootFlag.value,
        ...(graphAdapter.adapter ? { adapter: graphAdapter.adapter } : {}),
        ...(outFlag.value ? { out: outFlag.value } : {}),
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
      });
      if (!result.ran) {
        io.log(`⚠ graph skipped: ${result.skippedReason}`);
        return 0;
      }
      const s = result.model.summary;
      io.log(
        `graph: ${result.model.nodes.length} node(s), ${result.model.edges.length} edge(s) ` +
          `(${s.gap} gap / ${s.partial} partial / ${s.met} met${result.repoResolved ? "" : ", structural"})`,
      );
      io.log(`wrote ${result.outputPath}`);
      return 0;
    }
    case "overview": {
      // Interactive, self-contained system-map HTML for developer comprehension:
      // every loop clickable, expanding to plain-language detail (what it does,
      // code location, test coverage, implementation status). Written to the
      // gitignored ws/ side-channel. Advisory/read-only: always exit 0.
      const repoRootFlag = readStringFlag(flags, "repo-root");
      const outFlag = readStringFlag(flags, "out");
      for (const f of [repoRootFlag, outFlag]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      const overviewAdapter = await gateAdapter(
        flags,
        repoRootFlag.value ?? targetDir,
        io,
        /* gateable */ false, // overview is advisory/read-only: always exit 0 (below)
      );
      if ("halt" in overviewAdapter) return overviewAdapter.halt;

      const result = await runOverview(targetDir, {
        repoRoot: repoRootFlag.value,
        ...(overviewAdapter.adapter ? { adapter: overviewAdapter.adapter } : {}),
        ...(outFlag.value ? { out: outFlag.value } : {}),
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
      });
      if (!result.ran) {
        io.log(`⚠ overview skipped: ${result.skippedReason}`);
        return 0;
      }
      const s = result.model.summary;
      // "N background" was a CONCLUSION the number does not support: the bucket's
      // only criterion is "no flow references it", and on a real 30-loop model
      // 21 loops landed there including the main REPL loop (016 D7). The page
      // states the criterion; this line must not contradict it.
      io.log(
        `overview: ${s.loops} loop(s) (${s.inFlow} in ${s.flows} flow(s), ${s.background} 个不在任何链路里), ` +
          `${s.met} met / ${s.partial} partial / ${s.gap} gap${result.repoResolved ? "" : ", structural"}`,
      );
      io.log(`wrote ${result.outputPath}`);
      return 0;
    }
    case "topology": {
      // Self-contained architecture diagram from declared components + fact
      // topology hints — no model, no schema. Advisory/read-only: always
      // exit 0. See commands/topology.ts for the loud-skip contract (bad or
      // absent `components` config skips; absent facts degrades instead).
      const repoRootFlag = readStringFlag(flags, "repo-root");
      const outFlag = readStringFlag(flags, "out");
      const compareEdgesFlag = readStringFlag(flags, "compare-edges");
      for (const f of [repoRootFlag, outFlag, compareEdgesFlag]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      const topologyAdapter = await gateAdapter(
        flags,
        repoRootFlag.value ?? targetDir,
        io,
        /* gateable */ false, // topology is advisory/read-only: always exit 0 (below)
      );
      if ("halt" in topologyAdapter) return topologyAdapter.halt;

      const result = await runTopology(targetDir, {
        repoRoot: repoRootFlag.value,
        ...(topologyAdapter.adapter ? { adapter: topologyAdapter.adapter } : {}),
        ...(outFlag.value ? { out: outFlag.value } : {}),
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
        ...(compareEdgesFlag.value ? { compareEdges: compareEdgesFlag.value } : {}),
      });
      if (!result.ran) {
        // config_error is a real problem (malformed `.codeontic/config.json`)
        // — surfaced via io.error with a "✗" prefix, the same severity `check`
        // gives its own `inv1ConfigError`, not lumped in with the routine
        // "nothing declared yet" skip. Still exits 0 either way: topology is
        // advisory/read-only, same red line as graph/overview/snapshot.
        if (result.skipKind === "config_error") {
          io.error(`✗ topology skipped: ${result.skippedReason}`);
        } else {
          io.log(`⚠ topology skipped: ${result.skippedReason}`);
        }
        return 0;
      }
      const s = result.model.summary;
      io.log(
        `topology: ${s.components} component(s), ${s.external} external dependenc(y/ies), ${s.edges} edge(s)${
          result.model.unattributedCount > 0
            ? ` (${result.model.unattributedCount} unattributed fact(s))`
            : ""
        }${result.model.factsRan ? "" : " (no facts — components only)"}`,
      );
      // --compare-edges (issue #23 §4 / 阶段3 PR8): a bad file is a loud ✗
      // error (never lumped in with "no diff attempted") but never flips the
      // exit code — topology stays advisory/read-only end to end, same red
      // line as the config_error branch above.
      if (result.edgeDiff) {
        if (result.edgeDiff.status === "error") {
          io.error(`✗ --compare-edges: ${result.edgeDiff.message}`);
        } else {
          const d = result.edgeDiff.diff.summary;
          // Three presentations, not two — see `staticCoverageNaReason`'s
          // own doc: a nonzero-but-tiny denominator gets the same "don't
          // print a misleading number" treatment as a zero one, just with
          // the raw counts still shown (they exist and aren't themselves
          // misleading — only the ratio computed from them would be).
          const coverage =
            d.staticCoverage !== null
              ? `${d.confirmed}/${d.staticCoverageDenominator} = ${(d.staticCoverage * 100).toFixed(0)}%`
              : d.staticCoverageDenominator === 0
                ? `n/a (${d.staticCoverageNaReason ?? "no comparable static edges"})`
                : `${d.confirmed}/${d.staticCoverageDenominator} (no percentage: ${d.staticCoverageNaReason ?? "sample too small"})`;
          io.log(
            `edge diff: ${d.confirmed} confirmed / ${d.staticOnly} static-only / ${d.observedOnly} observed-only / ${d.unobservable} unobservable / ${d.queueMediated} queue-mediated — static coverage ${coverage}`,
          );
          if (!d.observableScopeDeclared) {
            io.log(
              "  ⚠ no observableComponents declared in the --compare-edges file — every would-be static-only edge is conservatively bucketed as unobservable (not claimed dead)",
            );
          }
          if (!d.targetKindsScopeDeclared) {
            io.log(
              "  ⚠ no observableTargetKinds declared in the --compare-edges file — every static edge pointing at an external dependency is conservatively bucketed as unobservable (this observation method may structurally be unable to see some target kinds, e.g. a direct DB connection)",
            );
          }
          if (d.targetKindsScopeDeclared && d.targetKindsUncheckable > 0) {
            io.log(
              `  ⚠ ${d.targetKindsUncheckable} edge(s) have a target with no toKind at all — your declared observableTargetKinds does not reach them (they're classified on the source axis alone); not a problem with your declaration, the adapter just never tagged these targets`,
            );
          }
          if (d.observedTotal === 0) {
            io.log(
              "  ⚠ --compare-edges file's edges array is empty — no observed data participated in this comparison at all",
            );
          }
          const diff = result.edgeDiff.diff;
          if (diff.selfLoopEdgesExcluded > 0) {
            io.log(
              `  ℹ excluded ${diff.selfLoopEdgesExcluded} self-referencing edge(s) (source === target) — almost always a collection artifact (e.g. a browser request counting its own domain as an outbound call), not counted in any bucket`,
            );
          }
          if (diff.nameSimilarityHints.length > 0) {
            io.log(
              `  ⚠ ${diff.nameSimilarityHints.length} observed-only/static-only target name pair(s) look similar — possibly the same dependency named differently on each side (not auto-merged, verify): ${diff.nameSimilarityHints
                .map((h) => `${h.observedId} ↔ ${h.staticId}`)
                .join(", ")}`,
            );
          }
        }
      }
      io.log(`wrote ${result.outputPath}`);
      return 0;
    }
    case "snapshot": {
      // T2 nightly full-scan artifact (Proposal 006 D2). NEVER a PR gate
      // (001 §6): this always exits 0 — drift is reported, not failed on.
      const repoRootFlag = readStringFlag(flags, "repo-root");
      const outFlag = readStringFlag(flags, "out");
      const driftFlag = readStringFlag(flags, "drift");
      for (const f of [repoRootFlag, outFlag, driftFlag]) {
        if (f.error) {
          io.error(`${f.error}. ${USAGE}`);
          return 1;
        }
      }
      // Machine-readable drift, for the PR-time delivery issue #38 asks for:
      // a PR job diffs its base snapshot against this run and tells the
      // author, on the spot, which topology edges the PR adds. Those edges
      // deliberately no longer move `clean` (see `SnapshotDrift.clean`), so
      // nightly is the wrong place to expect anyone to notice them — and
      // `package.json` ships `bin` only, no `main`/`exports`, so a CI job
      // cannot `import { diffSnapshots }`. A CLI flag is the only path.
      // `=== true` per this file's boolean-flag convention (see
      // `no-follow-delegation`): `--drift-json <token>` swallows the token
      // and reads as unset, which surfaces as text a consumer's `JSON.parse`
      // rejects loudly rather than as wrong data.
      const driftJson = flags["drift-json"] === true;
      if (driftJson && !driftFlag.value) {
        // Without `--drift` there is nothing to diff against, so this would
        // emit `{ran:false}` forever — a typo that quietly reports "no new
        // edges" on every PR is exactly the silent-pass this command exists
        // to prevent. Reject the invocation instead. (Unrelated to snapshot
        // never being a PR gate: that governs findings, not malformed args.)
        io.error(`--drift-json requires --drift <prior.json>. ${USAGE}`);
        return 1;
      }
      const snapshotAdapter = await gateAdapter(
        flags,
        repoRootFlag.value ?? targetDir,
        // Under `--drift-json` stdout is a DATA channel, so the adapter status
        // banner is redirected to stderr rather than dropped: it still reaches
        // a CI job's log (`… --drift-json 2>debug.log | jq`), it just stops
        // corrupting the one JSON value stdout promises. `error` already goes
        // to stderr, so a broken adapter is unaffected either way.
        driftJson ? { log: io.error, error: io.error } : io,
        /* gateable */ false, // T2 snapshot is NEVER a PR gate (001 §6): always exit 0
      );
      if ("halt" in snapshotAdapter) return snapshotAdapter.halt;
      const snapshot = await runSnapshot(targetDir, {
        repoRoot: repoRootFlag.value,
        ...(flags["no-cache"] === true ? { cacheDir: null } : {}),
        ...(snapshotAdapter.adapter ? { adapter: snapshotAdapter.adapter } : {}),
      });
      if (!driftJson) io.log(renderSnapshotSummary(snapshot));

      // Seeded with the one state the guard above already ruled out, so the
      // `--drift-json` emit below can never print `undefined` — if this text
      // ever reaches a consumer it names its own cause rather than failing as
      // a malformed JSON value.
      let driftPayload: DriftJsonPayload = {
        ran: false,
        skippedReason: "--drift was not given",
      };
      if (driftFlag.value) {
        const prior = await loadSnapshot(driftFlag.value);
        if (!prior) {
          const skippedReason = `no readable prior snapshot at ${driftFlag.value}`;
          driftPayload = { ran: false, skippedReason };
          if (!driftJson) io.log(`⚠ --drift: ${skippedReason} — skipping drift`);
        } else {
          const drift = diffSnapshots(prior, snapshot);
          // Projected from signals that already exist — never recomputed here
          // (CONTRIBUTING: 派生判断只定义一处). The wording comes from whichever
          // snapshot produced it; this only picks WHICH one to show.
          //
          // THIS run's reason first. `diffSnapshots` reports the previous
          // snapshot's cause when both sides lack edges, and that one is a
          // property of a file on disk from some earlier run — true, but not
          // what the person running this command can act on. When the current
          // run is itself unable to produce edges, that is the actionable half.
          const edgesUnavailableReason =
            snapshot.topologyEdgesUnavailable ?? drift.edgesSkippedReason;
          const edges: DriftJsonEdgeStatus = edgesUnavailableReason
            ? { comparable: false, reason: edgesUnavailableReason }
            : { comparable: true };
          driftPayload = { ran: true, edges, drift };
          if (!driftJson) for (const line of renderDrift(drift)) io.log(line);
        }
      }

      const outPath = outFlag.value ?? `${targetDir}/.codeontic/snapshot.json`;
      await writeSnapshot(outPath, snapshot);
      // `--drift-json` ALWAYS emits exactly one JSON value on stdout, in
      // EITHER ran state, and nothing else — same contract as `backtest
      // --json` above, for the same reason (a consumer pipes this straight
      // into `JSON.parse`). The snapshot artifact is still written: the flag
      // changes what this command SAYS, never what it produces.
      if (driftJson) {
        io.log(JSON.stringify(driftPayload, null, 2));
        return 0;
      }
      io.log(`wrote ${outPath}`);
      return 0;
    }
    default: {
      if (command && (QUERY_COMMANDS as readonly string[]).includes(command)) {
        // impact / plan / scenario / evidence <id> [dir]
        const id = positionals[0];
        if (!id) {
          io.error(`missing <id> for \`${command}\`. ${USAGE}`);
          return 1;
        }
        const queryTargetDir = positionals[1] ?? process.cwd();
        let result: Awaited<ReturnType<typeof runQuery>>;
        try {
          result = await runQuery(queryTargetDir, command as QueryCommand, id);
        } catch (err) {
          io.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
        if (result.staleWarning) io.log(`⚠ ${result.staleWarning}`);
        io.log(result.summary);
        return 0;
      }
      io.error(`unknown command "${command ?? ""}". ${USAGE}`);
      return 1;
    }
  }
}
