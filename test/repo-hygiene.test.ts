import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("repo hygiene", () => {
  /**
   * Runs the lint command CI runs — `biome check .`, the whole repo — rather
   * than the `src test` subset that is quicker to type.
   *
   * Those two differ, and the difference is not academic: a hand-edit to
   * `biome.json` left it in a shape biome's own formatter disagreed with, so
   * `pnpm lint` failed on the config file itself while `biome check src test`
   * stayed green through several rounds of verification. Config, workflows and
   * changesets are part of the repo; the check that gates the build looks at
   * all of them, so the suite does too.
   */
  it("the whole repo passes the lint command CI uses", async () => {
    await expect(exec("npx", ["biome", "check", "."], { cwd: repoRoot })).resolves.toBeDefined();
  }, 60_000);
});
