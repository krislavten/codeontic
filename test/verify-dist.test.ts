import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-dist.mjs");

/**
 * The publish gate (`prepublishOnly`).
 *
 * It exists because of a failure that was silent end to end: tsc's incremental
 * build info outlived the `dist/` it described, so a build emitted nothing and
 * still exited 0, and `npm publish` — which runs no build of its own — would
 * have shipped an empty tarball with every command green. `tsconfig.build.json`
 * fixes that specific cause; this guard catches the same SHAPE arriving another
 * way, so it has to actually fail when dist is unusable.
 */
async function runGuard(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, root]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("verify-dist — the publish gate", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codeontic-verify-dist-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", bin: { codeontic: "dist/cli/index.js" } }),
    );
    await mkdir(join(root, "dist", "cli"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeEntry = (content: string) => writeFile(join(root, "dist", "cli", "index.js"), content);

  it("passes on a dist whose declared entry point is present and looks built", async () => {
    await writeEntry("#!/usr/bin/env node\nconsole.log('hi');\n");
    const r = await runGuard(root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ok/);
  });

  /** The exact scenario that motivated the guard: build emitted nothing. */
  it("fails when the entry point is missing entirely (empty dist)", async () => {
    const r = await runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/dist\/cli\/index\.js/);
    expect(r.stderr).toMatch(/missing from disk/);
  });

  it("fails when the entry point exists but is empty (truncated/partial write)", async () => {
    await writeEntry("");
    const r = await runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/empty/);
  });

  /**
   * A file can exist and be non-empty and still not be the built CLI — e.g. a
   * leftover placeholder. The shebang is the cheapest evidence that this is
   * real compiled output rather than something that merely occupies the path.
   */
  it("fails when the entry point exists but carries no shebang", async () => {
    await writeEntry("console.log('not the cli');\n");
    const r = await runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/shebang/);
  });

  it("refuses a package.json that declares nothing to verify, rather than passing vacuously", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    const r = await runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no bin\/main\/types/);
  });

  /** Every path package.json promises, not just the first one. */
  it("checks main and types too, not only bin", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        bin: { codeontic: "dist/cli/index.js" },
        main: "dist/index.js",
        types: "dist/index.d.ts",
      }),
    );
    await writeEntry("#!/usr/bin/env node\n");
    const r = await runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/dist\/index\.js/);
    expect(r.stderr).toMatch(/dist\/index\.d\.ts/);
  });
});
