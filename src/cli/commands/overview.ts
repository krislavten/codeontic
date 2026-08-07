import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Adapter } from "../../adapters/types.js";
import { runFacts } from "../../facts/runner.js";
import { loadModel } from "../../loader/load-model.js";
import type { ModelGraph } from "../../loader/model-graph.js";
import { computeBacktest } from "../../query/backtest.js";
import { anchorFilesToResolve, computeConformance } from "../../query/conformance.js";
import { gitRootOf } from "../../query/diff.js";
import { computeStalenessStamp } from "../../staleness.js";
import type { StalenessStamp } from "../../staleness.js";
import { computeOverviewModel, renderOverviewHtml, repoLinks } from "../../views/overview-html.js";
import type { OverviewModel } from "../../views/overview-html.js";
import { DEFAULT_BACKTEST_WINDOW, collectBacktestCommits } from "./backtest.js";

const execFileAsync = promisify(execFile);

/**
 * Best-effort: turn the repo's `origin` remote + HEAD sha into the code-link base
 * so each anchor becomes a clickable GitHub/GitLab URL. Any failure (no remote,
 * not a git repo, unparseable remote) yields null and links simply stay off — a
 * projection convenience, never a hard dependency.
 */
async function resolveRepoLinks(
  repoRoot: string,
): Promise<{ blobBase: string; repoHref: string; repoLabel: string } | null> {
  try {
    const [{ stdout: remote }, { stdout: ref }] = await Promise.all([
      execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoRoot }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    ]);
    return repoLinks(remote.trim(), ref.trim());
  } catch {
    return null;
  }
}

/**
 * Commit-side half of the page's coverage declaration (016 T5): of the recent
 * `.ts`/`.tsx`-touching commits, how many landed on a file the model anchors.
 * Reuses `backtest`'s own collection + computation rather than re-deriving it,
 * so the number on the page and the number `codeontic backtest` prints can
 * never disagree.
 *
 * Best-effort exactly like `resolveRepoLinks` above: not a git checkout, an
 * unborn HEAD, a git that isn't there — all yield null and the page simply
 * shows the model-side file count alone. A coverage extra must never be able
 * to turn `overview` into a failure.
 */
async function resolveCommitTouch(
  repoRoot: string,
  graph: ModelGraph,
): Promise<{ hit: number; total: number } | null> {
  try {
    const gitRoot = await gitRootOf(repoRoot);
    if (!gitRoot) return null;
    const collected = await collectBacktestCommits(gitRoot, "HEAD", DEFAULT_BACKTEST_WINDOW);
    if (!collected || collected.commits.length === 0) return null;
    const { overall } = computeBacktest(graph, collected.commits);
    return { hit: overall.hit, total: overall.total };
  } catch {
    return null;
  }
}

export type OverviewResult =
  | {
      ran: true;
      outputPath: string;
      model: OverviewModel;
      stamp: StalenessStamp;
      repoResolved: boolean;
    }
  | { ran: false; skippedReason: string };

export interface OverviewOptions {
  /** Repo checkout root — resolves anchor/test files so implementation status is verified, not just declared. */
  repoRoot?: string | undefined;
  /** Adapter for queue-fact matching (optional; only affects queue-unmatched status). */
  adapter?: Adapter | undefined;
  /** Output path override; defaults to `<dir>/.codeontic/ws/overview.html`. */
  out?: string | undefined;
  cacheDir?: string | null | undefined;
}

/**
 * `codeontic overview`: write the interactive, self-contained system-map HTML into
 * the gitignored `.codeontic/ws/` side-channel (a projection, regenerated on
 * demand, never committed). Same I/O and skip discipline as `graph`: a missing
 * model dir or an all-parse-error load is a loud `ran: false`, never a page
 * rendering an empty or fictional map. Without `--repo-root` the implementation
 * status is structural (declared, not verified) and the page says so.
 */
export async function runOverview(
  targetDir: string,
  options: OverviewOptions = {},
): Promise<OverviewResult> {
  let load: Awaited<ReturnType<typeof loadModel>>;
  try {
    load = await loadModel(join(targetDir, ".codeontic", "model"));
  } catch (err) {
    return { ran: false, skippedReason: err instanceof Error ? err.message : String(err) };
  }

  const parseErrors = load.parseErrors.length;
  if (parseErrors > 0 && load.entries.length === 0) {
    return {
      ran: false,
      skippedReason: `all ${parseErrors} model file(s) failed to parse — run "codeontic check" for the errors`,
    };
  }

  const inputs: Parameters<typeof computeConformance>[1] = {};
  let existingFiles: Set<string> | undefined;
  if (options.repoRoot !== undefined) {
    const repoRoot = options.repoRoot;
    existingFiles = new Set<string>();
    await Promise.all(
      anchorFilesToResolve(load.graph).map(async (rel) => {
        const ok = await access(join(repoRoot, rel))
          .then(() => true)
          .catch(() => false);
        if (ok) existingFiles?.add(rel);
      }),
    );
    inputs.existingFiles = existingFiles;
    if (options.adapter) {
      const facts = await runFacts(repoRoot, {
        ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
        adapter: options.adapter,
      });
      if (facts.ran) {
        const nameMatchable = new Set(options.adapter.nameMatchableSignalKinds ?? []);
        inputs.queueFactNames = new Set(
          facts.facts.filter((f) => nameMatchable.has(f.signal)).map((f) => f.name),
        );
      }
    }
  }

  const conformance = computeConformance(load.graph, inputs, parseErrors);
  const model = computeOverviewModel(load.graph, conformance, existingFiles);
  const stamp = await computeStalenessStamp(join(targetDir, ".codeontic", "model"), targetDir);
  const [links, commitTouch] = await Promise.all([
    options.repoRoot !== undefined ? resolveRepoLinks(options.repoRoot) : null,
    options.repoRoot !== undefined ? resolveCommitTouch(options.repoRoot, load.graph) : null,
  ]);

  const html = renderOverviewHtml(model, {
    title: `${model.summary.loops} loop · ${model.summary.flows} flow · ${model.summary.junctions} junction`,
    repoResolved: conformance.repoResolved,
    generatedAt: stamp.generatedAt,
    modelHash: stamp.modelContentHash,
    commitTouch,
    ...(links
      ? { blobBase: links.blobBase, repoHref: links.repoHref, repoLabel: links.repoLabel }
      : {}),
  });

  const outputPath = options.out ?? join(targetDir, ".codeontic", "ws", "overview.html");
  await mkdir(join(targetDir, ".codeontic", "ws"), { recursive: true });
  await writeFile(
    outputPath,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${html}`,
    "utf8",
  );

  return { ran: true, outputPath, model, stamp, repoResolved: conformance.repoResolved };
}
