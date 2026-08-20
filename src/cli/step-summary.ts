import { appendFile } from "node:fs/promises";

/**
 * Writes markdown to `$GITHUB_STEP_SUMMARY` when that is set, and reports
 * whether it landed.
 *
 * APPENDING (not truncating) is what the file is for — several steps of one job
 * write to the same summary, and a truncating writer silently eats whatever ran
 * before it.
 *
 * NEVER THROWS. A summary file that is unset, read-only, or on a full disk is a
 * delivery problem for one rendering; letting it reject would take down the
 * command around it, including the two that promise never to fail. Callers get
 * `false` and print the markdown to stdout instead, so the content survives
 * either way.
 *
 * One function, because it was briefly two — `writeGithubSummary` in
 * gate-render.ts and `appendGithubSummary` in report.ts, byte-for-byte
 * identical, the second carrying a comment pointing at the first. Two names for
 * one behaviour is how they drift apart later.
 */
export async function writeStepSummary(markdown: string): Promise<boolean> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return false;
  try {
    await appendFile(target, markdown, "utf8");
    return true;
  } catch {
    return false;
  }
}
