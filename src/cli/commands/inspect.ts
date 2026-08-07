import { join } from "node:path";
import { loadModel } from "../../loader/load-model.js";
import { writeSideChannel } from "../../query/side-channel.js";
import { sliceModel } from "../../query/slice.js";
import { renderSliceMarkdown, summarizeSlice } from "../../query/summary.js";

export interface InspectOptions {
  /** Traversal depth (default 2, proposal 001 §4.2 / 006 A5). */
  depth?: number;
}

export interface InspectResult {
  rootId: string;
  outputPath: string;
  /** Compact stdout digest (skeletons kept, evidence/scenario prose truncated). */
  summary: string;
  /**
   * Set when a pre-existing side-channel file for this id was stale vs the
   * current model — the Decision 004 技术点 4 consumer. See writeSideChannel.
   */
  staleWarning?: string;
}

const DEFAULT_DEPTH = 2;

/**
 * `codeontic inspect <node-id>`: slice the model around one node and write a
 * staleness-stamped side-channel file, returning a compact summary for stdout
 * (proposal 001 §4.2 shape: summary + workspace file path). Throws on an
 * unknown id or unparseable model — the CLI turns those into exit code 1.
 */
export async function runInspect(
  targetDir: string,
  nodeId: string,
  options: InspectOptions = {},
): Promise<InspectResult> {
  const depth = options.depth ?? DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`--depth must be a non-negative integer, got "${depth}"`);
  }

  const load = await loadModel(join(targetDir, ".codeontic", "model"));
  if (load.parseErrors.length > 0) {
    throw new Error(
      `model has ${load.parseErrors.length} parse error(s) — run "codeontic check" first`,
    );
  }

  const slice = sliceModel(load.graph, nodeId, depth);
  if (!slice) {
    throw new Error(`unknown node id "${nodeId}" — not a feature/flow/loop/junction/scenario/debt`);
  }

  // node ids match the id-regex charset (L1 / C1 / J-x / GWT-x), all filename-safe.
  const { outputPath, staleWarning } = await writeSideChannel(
    targetDir,
    `inspect-${nodeId}`,
    (banner) => renderSliceMarkdown(slice, banner),
  );

  return {
    rootId: nodeId,
    outputPath,
    summary: summarizeSlice(slice, outputPath),
    ...(staleWarning ? { staleWarning } : {}),
  };
}
