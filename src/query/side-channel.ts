import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeStalenessStamp,
  formatStalenessBanner,
  isStale,
  parseStalenessBanner,
} from "../staleness.js";

export interface SideChannelResult {
  outputPath: string;
  /** Set when a pre-existing file for this tag was stale vs the current model. */
  staleWarning?: string;
}

function shortHash(h: string): string {
  return h.slice(0, 12);
}

/**
 * Shared side-channel writer for the query family (extracted from A5's inspect
 * so inspect/impact/plan/scenario/evidence don't each re-implement it). Writes
 * `<targetDir>/.codeontic/ws/<fileTag>.md`, stamped with a staleness banner,
 * and — before overwriting — reads any prior file and warns if it was stale
 * (Decision 004 技术点 4 consumer). `buildBody` receives the banner to place it
 * wherever the body wants (top, by convention).
 *
 * Concurrency: the side-channel file is a regenerated-on-demand ADVISORY
 * artifact, not source data — the model YAML is never touched here, only this
 * derived output. The read→judge→write is deliberately NOT locked: the worst
 * case under a race is a spurious/missed staleness *warning* plus one of two
 * near-identical regenerations winning; no model data is at risk, so a file
 * lock is not pulled in for a local dev tool. The write itself IS atomic — a
 * uniquely-named temp (`randomUUID`, so two concurrent writers in the SAME
 * process, e.g. two MCP tool calls for the same id, never collide on the temp)
 * then `rename`, so a reader never observes a half-written file.
 */
export async function writeSideChannel(
  targetDir: string,
  fileTag: string,
  buildBody: (banner: string) => string,
): Promise<SideChannelResult> {
  const modelDir = join(targetDir, ".codeontic", "model");
  const currentStamp = await computeStalenessStamp(modelDir, targetDir);

  const wsDir = join(targetDir, ".codeontic", "ws");
  await mkdir(wsDir, { recursive: true });
  const outputPath = join(wsDir, `${fileTag}.md`);

  let staleWarning: string | undefined;
  const prior = await readFile(outputPath, "utf8").catch(() => undefined);
  if (prior) {
    const priorStamp = parseStalenessBanner(prior);
    if (priorStamp && isStale(priorStamp, currentStamp)) {
      staleWarning = `prior ${outputPath} was stale: model_content_hash ${shortHash(priorStamp.modelContentHash)} != current ${shortHash(currentStamp.modelContentHash)} — regenerated`;
    }
  }

  const body = buildBody(formatStalenessBanner(currentStamp));
  const tmpPath = `${outputPath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, outputPath);

  return { outputPath, ...(staleWarning ? { staleWarning } : {}) };
}
