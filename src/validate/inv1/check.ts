import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Violation } from "../types.js";
import type { Inv1Config } from "./config.js";
import { type WritePoint, scanFileForGuardedWrites } from "./scan.js";

const execFileAsync = promisify(execFile);

export interface Inv1CheckResult {
  /** false when the scan couldn't run (no git checkout) — a loud skip, not a silent pass. */
  ran: boolean;
  skippedReason?: string;
  /** Every classified write point (allowed + violation + unanalyzable) — the inventory for human verification. */
  writePoints: WritePoint[];
  candidateFiles: number;
  filesScanned: number;
  timingMs: number;
}

/**
 * Candidate pre-filter (proposal 001 §6 / 006 A6: "grep 预筛候选文件，再对候选做
 * AST 确认"). `git grep -l` is the impure narrowing step (fast, tracked files
 * only, respects .gitignore); the pure AST scan then confirms each candidate.
 * Returns undefined when the target is not a usable git checkout.
 *
 * Pattern `update\(` (not `\.update\(`) so a destructured/re-exported binding
 * `const { update } = db; update(runs)…` still lands a file in the candidate
 * set — under-matching here would be a silent miss, over-matching only costs a
 * cheap extra AST parse. The one residual is a *renamed* method
 * (`const u = db.update`), which no grep pattern for `update(` can catch — a
 * documented limitation (does not occur in the target today).
 */
async function gitGrepCandidates(repoRoot: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["grep", "-lE", "update\\(", "--", "*.ts", ":!*.test.ts", ":!*.spec.ts"],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    // git grep exits 1 when there are simply NO matches — an empty candidate
    // set, not a failure. Any other exit (128 = not a repo, ENOENT = no git)
    // is a real "cannot run" and surfaces as a skip.
    if ((err as { code?: number }).code === 1) return [];
    return undefined;
  }
}

export interface Inv1CheckOptions {
  /**
   * Incremental mode (B2): when set, only candidate files also in this set are
   * scanned — the diff closure, not the whole repo. `candidateFiles` still
   * reports the full candidate count so the ratio (scanned/candidate) is visible.
   */
  onlyFiles?: Set<string>;
}

/**
 * Runs the INV-1 canonical-writer scan over `repoRoot` using `config`. Kept
 * OUT of `runT0` on purpose (see t0.ts docstring): it needs a whole-repo scan,
 * so it is timed and gated independently. The scan primitive it calls is pure;
 * only the candidate selection + file reads here do I/O.
 */
export async function runInv1Check(
  repoRoot: string,
  config: Inv1Config,
  options: Inv1CheckOptions = {},
): Promise<Inv1CheckResult> {
  const start = performance.now();
  const candidates = await gitGrepCandidates(repoRoot);
  if (candidates === undefined) {
    return {
      ran: false,
      skippedReason: "INV-1 scan needs a git checkout (git grep unavailable at repo-root)",
      writePoints: [],
      candidateFiles: 0,
      filesScanned: 0,
      timingMs: performance.now() - start,
    };
  }

  const toScan = options.onlyFiles
    ? candidates.filter((c) => options.onlyFiles?.has(c))
    : candidates;
  const writePoints: WritePoint[] = [];
  let filesScanned = 0;
  for (const rel of toScan) {
    const content = await readFile(join(repoRoot, rel), "utf8").catch(() => undefined);
    if (content === undefined) continue; // a listed-but-unreadable file (race/symlink) — skip, don't crash
    filesScanned++;
    writePoints.push(...scanFileForGuardedWrites(rel, content, config));
  }

  return {
    ran: true,
    writePoints,
    candidateFiles: candidates.length,
    filesScanned,
    timingMs: performance.now() - start,
  };
}

/**
 * Maps scan write points to T0 violations: a `violation` verdict is a blocking
 * error (a guarded column written from outside the allowlist); `unanalyzable`
 * is an advisory warning (surfaced for human confirmation, never silently
 * passed); `allowed` points are inventory only, not violations.
 */
export function inv1ViolationsFrom(result: Inv1CheckResult): Violation[] {
  const out: Violation[] = [];
  for (const wp of result.writePoints) {
    if (wp.verdict === "allowed") continue;
    out.push({
      check: "inv1-write-site",
      severity: wp.verdict === "violation" ? "error" : "warning",
      message: `${wp.reason} — ${wp.filePath}:${wp.line} (${wp.snippet})`,
      file: wp.filePath,
      // Deliberately WITHOUT the line: an edit elsewhere in the file shifts it,
      // and a shifted long-standing violation is not a new one. The snippet
      // keeps two distinct write sites in one file apart.
      identity: `${wp.reason}|${wp.filePath}|${wp.snippet}`,
    });
  }
  return out;
}
