import { mkdir, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter } from "../../adapters/types.js";
import { runFacts } from "../../facts/runner.js";
import { loadModel } from "../../loader/load-model.js";
import { computeConformance } from "../../query/conformance.js";
import { anchorFilesToResolve } from "../../query/conformance.js";
import { computeStalenessStamp, formatStalenessBanner } from "../../staleness.js";
import type { StalenessStamp } from "../../staleness.js";
import { computeGraphModel, renderGraphHtml } from "../../views/graph-html.js";
import type { GraphModel } from "../../views/graph-html.js";

export type GraphResult =
  | {
      ran: true;
      outputPath: string;
      model: GraphModel;
      stamp: StalenessStamp;
      repoResolved: boolean;
    }
  | { ran: false; skippedReason: string };

export interface GraphOptions {
  /** Repo checkout root — colors nodes by conformance resolved against real code. */
  repoRoot?: string | undefined;
  /** Adapter for queue-fact matching (optional). */
  adapter?: Adapter | undefined;
  /** Output path override; defaults to `<dir>/.codeontic/ws/graph.html`. */
  out?: string | undefined;
  cacheDir?: string | null | undefined;
}

/**
 * `codeontic graph`: write a self-contained, conformance-colored HTML view of
 * the whole model into the gitignored `.codeontic/ws/` side-channel (same posture
 * as `view`: regenerated on demand, staleness-stamped, never committed — it is a
 * projection of the model, not a source of truth).
 *
 * Same skip discipline as `coverage`/`conformance`: a missing model dir or an
 * all-parse-error load is a loud `ran: false`, never a page rendering an empty
 * or fictional graph. Without `--repo-root` the conformance colors are
 * structural (declared, not verified) and the page says so.
 */
export async function runGraph(
  targetDir: string,
  options: GraphOptions = {},
): Promise<GraphResult> {
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

  // Resolve conformance (optionally against a real checkout) so the graph can
  // be colored. This mirrors runConformance's I/O but is inlined to keep the
  // one render path self-contained.
  const inputs: Parameters<typeof computeConformance>[1] = {};
  if (options.repoRoot !== undefined) {
    const repoRoot = options.repoRoot;
    const existing = new Set<string>();
    await Promise.all(
      anchorFilesToResolve(load.graph).map(async (rel) => {
        const ok = await access(join(repoRoot, rel))
          .then(() => true)
          .catch(() => false);
        if (ok) existing.add(rel);
      }),
    );
    inputs.existingFiles = existing;
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
  const model = computeGraphModel(load.graph, conformance);
  const modelDir = join(targetDir, ".codeontic", "model");
  const stamp = await computeStalenessStamp(modelDir, targetDir);

  const html = renderGraphHtml(model, {
    title: `${model.nodes.length} node(s) · ${model.edges.length} edge(s)`,
    stalenessBanner: formatStalenessBanner(stamp),
    repoResolved: conformance.repoResolved,
  });

  const outputPath = options.out ?? join(targetDir, ".codeontic", "ws", "graph.html");
  await mkdir(join(targetDir, ".codeontic", "ws"), { recursive: true });
  await writeFile(
    outputPath,
    `<!doctype html><meta charset="utf-8"><title>codeontic graph</title>${html}`,
    "utf8",
  );

  return { ran: true, outputPath, model, stamp, repoResolved: conformance.repoResolved };
}
