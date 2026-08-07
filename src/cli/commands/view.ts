import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModel } from "../../loader/load-model.js";
import { computeStalenessStamp, formatStalenessBanner } from "../../staleness.js";
import type { StalenessStamp } from "../../staleness.js";
import { renderFlowMermaid } from "../../views/flow-mermaid.js";
import { validateMermaid } from "../../views/validate-mermaid.js";
import type { MermaidValidationResult } from "../../views/validate-mermaid.js";

export interface ViewOptions {
  /**
   * Actually render the generated mermaid with mmdc and report whether
   * it parses (Decision record 004 技术点 5). Off by default: mmdc needs
   * a real puppeteer-launched browser, which isn't a fair default
   * runtime requirement for every consumer of `codeontic view` — see
   * src/views/validate-mermaid.ts's docstring.
   */
  validate?: boolean;
}

export interface ViewResult {
  flowId: string;
  outputPath: string;
  mermaid: string;
  stamp: StalenessStamp;
  validation?: MermaidValidationResult;
}

/**
 * Generates a mermaid view for one Flow (Phase 1 scope: C1 only, per
 * proposal 001 §12) and writes it, staleness-stamped, to the
 * `.codeontic/ws/` side-channel (proposal 001 §5 — query-side-channel
 * output, gitignored, regenerated on demand, not a cache).
 *
 * Always writes the file, even when `--validate` reports the diagram
 * invalid — same posture as `codeontic check`, which reports violations
 * rather than refusing to run: hiding the broken output would remove
 * the one artifact useful for debugging what went wrong. The CLI layer
 * (src/cli/run.ts) is what turns an "invalid" validation result into a
 * non-zero exit code.
 */
export async function runView(
  targetDir: string,
  flowId: string,
  options: ViewOptions = {},
): Promise<ViewResult> {
  const modelDir = join(targetDir, ".codeontic", "model");
  const load = await loadModel(modelDir);
  if (load.parseErrors.length > 0) {
    throw new Error(
      `model has ${load.parseErrors.length} parse error(s) — run "codeontic check" first`,
    );
  }

  const mermaid = renderFlowMermaid(load.graph, flowId);
  const stamp = await computeStalenessStamp(modelDir, targetDir);

  const wsDir = join(targetDir, ".codeontic", "ws");
  await mkdir(wsDir, { recursive: true });
  const outputPath = join(wsDir, `view-${flowId}.md`);
  const body = [
    formatStalenessBanner(stamp),
    "",
    `# ${flowId} view`,
    "",
    "```mermaid",
    mermaid,
    "```",
    "",
  ].join("\n");
  await writeFile(outputPath, body, "utf8");

  const validation = options.validate ? await validateMermaid(mermaid) : undefined;
  return { flowId, outputPath, mermaid, stamp, ...(validation ? { validation } : {}) };
}
