import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Adapter } from "../../adapters/types.js";
import { mergeBaseOf } from "../../query/base-tree.js";
import { gitRootOf } from "../../query/diff.js";
import { type Snapshot, type SnapshotDrift, diffSnapshots, runSnapshot } from "./snapshot.js";

const execFileAsync = promisify(execFile);

/**
 * `codeontic drift-report` — "what service-to-service calls did this change
 * add?", answered on the spot instead of in a nightly nobody reads.
 *
 * The producing half (`snapshot --drift-json`) shipped in 0.8.0 and sat unused:
 * every consumer had to hand-write the base acquisition and the rendering, and
 * the one repo that did spent ~250 lines of workflow YAML on it, including a
 * 94-line embedded Node renderer and a three-way caveat system for telling
 * "the extractor changed" apart from "the architecture changed".
 *
 * Most of that machinery exists only because the two sides were produced by two
 * separately-installed engines. Here they are not: BOTH snapshots are taken by
 * THIS process — same adapter object, same component config — with only the
 * file tree differing. Extractor churn is therefore impossible by construction,
 * and the caveat it needed disappears rather than being reimplemented.
 */

export interface DriftReportOptions {
  repoRoot: string;
  base: string;
  adapter?: Adapter | undefined;
}

export interface DriftReportResult {
  ran: boolean;
  /** Why the comparison could not be made (ran === false). */
  reason?: string;
  drift?: SnapshotDrift;
  /** True when either side produced zero topology edges — liveness cannot be asserted. */
  topologyEmpty?: boolean;
  /**
   * Set when a side reported edges as UNAVAILABLE (`topologyEdges: null`) with
   * a cause. Folding that into `topologyEmpty` would throw the cause away and
   * leave a vague "one side had no edges" — the snapshot artifact carries the
   * reason precisely so the person reading tomorrow's report is not sent
   * looking for an architecture change that never happened.
   */
  edgesUnavailableReason?: string;
}

async function withBaseWorktree<T>(
  gitRoot: string,
  sha: string,
  fn: (dir: string) => Promise<T>,
): Promise<T | undefined> {
  const parent = await mkdtemp(join(tmpdir(), "codeontic-drift-"));
  const dir = join(parent, "base");
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", dir, sha], { cwd: gitRoot });
  } catch {
    await rm(parent, { recursive: true, force: true });
    return undefined;
  }
  try {
    return await fn(dir);
  } finally {
    // Both halves: git forgets the worktree, the filesystem loses the copy.
    // The hand-written version cleaned up only on the success path, and its
    // leftovers then collided with the next step's worktree at the same path.
    await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: gitRoot }).catch(
      () => undefined,
    );
    await rm(parent, { recursive: true, force: true });
  }
}

/**
 * How much of the checkout the scan covers, as a path relative to the git root
 * (`""` when it covers the whole thing).
 *
 * The base side is a WHOLE worktree while `--repo-root` may point INTO the repo
 * (`/repo/services/api`). Scanning the worktree root against a subdirectory HEAD
 * compares two different scopes: every edge belonging to the other services
 * reads as "removed by this change" — false, and exactly the kind of alarm that
 * teaches people to ignore the report.
 *
 * Both sides are realpath'd first: git reports the resolved root while the
 * caller's path may run through a symlink (on macOS every $TMPDIR does), and
 * comparing the two spellings raw yields a `../..`-shaped prefix that escapes
 * the worktree entirely.
 */
export async function scanPrefixOf(gitRoot: string, repoRoot: string): Promise<string> {
  const repoRootReal = await realpath(repoRoot).catch(() => resolve(repoRoot));
  const gitRootReal = await realpath(gitRoot).catch(() => gitRoot);
  const prefix = relative(gitRootReal, repoRootReal);
  // A prefix that climbs out (`..`) or is absolute means the two paths are not
  // in the ancestor relation git promised; scanning the worktree root is the
  // only safe reading left, and it is what the pre-0.13 behaviour did.
  return prefix && !prefix.startsWith("..") && !isAbsolute(prefix) ? prefix : "";
}

/** The base-side counterpart of `--repo-root`, inside a freshly-added worktree. */
export function baseRepoRootIn(baseDir: string, scanPrefix: string): string {
  return scanPrefix ? join(baseDir, scanPrefix) : baseDir;
}

export async function runDriftReport(
  targetDir: string,
  options: DriftReportOptions,
): Promise<DriftReportResult> {
  const gitRoot = await gitRootOf(options.repoRoot);
  if (!gitRoot) return { ran: false, reason: `${options.repoRoot} is not inside a git checkout` };

  const sha = await mergeBaseOf(gitRoot, options.base);
  if (!sha) {
    return { ran: false, reason: `no merge-base between "${options.base}" and HEAD (unfetched?)` };
  }

  const repoPrefix = await scanPrefixOf(gitRoot, options.repoRoot);

  // `cacheDir: null` on BOTH sides. The facts cache is keyed by adapter version
  // + path + content hash and does not include the adapter's own bytes, so a
  // warm entry written while scanning one tree can be served for the other —
  // which would report "no edge changes" precisely when the extractor changed.
  const snapshots = await withBaseWorktree(gitRoot, sha, async (baseDir) => {
    const base = await runSnapshot(targetDir, {
      repoRoot: baseRepoRootIn(baseDir, repoPrefix),
      cacheDir: null,
      ...(options.adapter ? { adapter: options.adapter } : {}),
    });
    const head = await runSnapshot(targetDir, {
      repoRoot: options.repoRoot,
      cacheDir: null,
      ...(options.adapter ? { adapter: options.adapter } : {}),
    });
    return { base, head };
  });
  if (!snapshots) return { ran: false, reason: `could not check out ${sha.slice(0, 12)}` };

  const drift = diffSnapshots(snapshots.base, snapshots.head);
  // The reason lives on the DRIFT (diffSnapshots already reconciles which side
  // was unavailable and why); the snapshots only carry the null itself. The
  // side is derived in the SAME order diffSnapshots uses (base first) — reading
  // head first made "本次侧" collide with a reason reading "previous snapshot:"
  // whenever both sides were null, i.e. the case most likely to be a real
  // outage, and therefore the one worth being precise about.
  const baseNull = snapshots.base.topologyEdges === null;
  const headNull = snapshots.head.topologyEdges === null;
  const nullSide =
    baseNull && headNull ? "两侧" : baseNull ? "基线侧" : headNull ? "本次侧" : undefined;
  const unavailable = nullSide
    ? `${nullSide}的边不可用：${drift.edgesSkippedReason ?? "引擎未给出原因"}`
    : undefined;
  return {
    ran: true,
    drift,
    // `null` is "could not compute, here is why"; `[]` is "computed, none
    // found". Only the latter is emptiness.
    topologyEmpty: isEmptyTopology(snapshots.base) || isEmptyTopology(snapshots.head),
    ...(unavailable ? { edgesUnavailableReason: unavailable } : {}),
  };
}

function isEmptyTopology(snapshot: Snapshot): boolean {
  return snapshot.topologyEdges !== null && snapshot.topologyEdges.length === 0;
}

export function renderDriftMarkdown(result: DriftReportResult): string {
  // Whether the numbers may be called "this change's" is decided by the DATA
  // (did both sides produce an edge set?), never by a caller-supplied flag: the
  // previous shape took an `attributable` parameter that no call site passed,
  // so asking for neutral wording silently produced the attributing wording.
  const canAttribute = result.ran && !result.topologyEmpty && !result.edgesUnavailableReason;
  const out: string[] = [
    canAttribute ? "## 本次改动新增的服务间调用边" : "## 服务间调用边 drift",
    "",
  ];
  if (!result.ran || !result.drift) {
    out.push(
      `⚠ **这次没能比较** —— ${result.reason ?? "未知原因"}。`,
      "",
      "> **这不等于「没有新增边」**，是「这次没查」：属管线/配置问题，需要修。",
    );
    return `${out.join("\n")}\n`;
  }

  const added = result.drift.addedEdges ?? [];
  const removed = result.drift.removedEdges ?? [];

  if (result.edgesUnavailableReason) {
    out.push(
      `⚠ **边集合不可用** —— ${result.edgesUnavailableReason}`,
      "先修这个成因，再看下面的读数；在那之前，下面的增减不能归因为架构变化。",
      "",
    );
  } else if (result.topologyEmpty) {
    out.push(
      "ℹ **有一侧的边集合是空的（扫描跑了，只是一条都没找到）。**",
      "下面的结果照常呈现，但它的活性无法在这里断言。",
      "",
    );
  }

  if (added.length === 0 && removed.length === 0) {
    out.push(
      canAttribute
        ? "本次改动没有新增或移除服务间调用边。"
        : "drift 未报告边集合变化（但按上面的说明，这里不能归因为「本次没动过」）。",
    );
    return `${out.join("\n")}\n`;
  }

  if (added.length > 0) {
    out.push(
      canAttribute
        ? `**本次改动新增了 ${added.length} 条服务间调用边：**`
        : `**drift 报告边集合新增 ${added.length} 条（成因待判读，见上）：**`,
      "",
      ...added.map((e) => `- \`${e.from}\` → \`${e.to}\`${e.toKind ? ` (${e.toKind})` : ""}`),
    );
    if (canAttribute) {
      out.push(
        "",
        "> 这不是问题，只是一件值得你知道的事：多了一条服务之间的依赖。如果它是有意的，",
        "> 不用做任何事；如果你没预期它出现，那就是这条提示的价值。",
      );
    }
  }
  if (removed.length > 0) {
    out.push(
      "",
      canAttribute
        ? `**本次改动移除了 ${removed.length} 条：**`
        : `**drift 报告边集合移除 ${removed.length} 条（成因待判读，见上）：**`,
      "",
      ...removed.map((e) => `- \`${e.from}\` → \`${e.to}\``),
    );
  }
  return `${out.join("\n")}\n`;
}

export function renderDriftText(result: DriftReportResult): string {
  if (!result.ran || !result.drift) {
    return `drift-report: not compared — ${result.reason ?? "unknown"} (this is NOT "no new edges").`;
  }
  const added = result.drift.addedEdges ?? [];
  const removed = result.drift.removedEdges ?? [];
  const lines = [`drift-report: +${added.length} / -${removed.length} topology edge(s)`];
  for (const e of added) lines.push(`  + ${e.from} → ${e.to}`);
  for (const e of removed) lines.push(`  - ${e.from} → ${e.to}`);
  if (result.edgesUnavailableReason) lines.push(`  (${result.edgesUnavailableReason})`);
  else if (result.topologyEmpty) lines.push("  (one side found no edges — liveness not asserted)");
  return lines.join("\n");
}
