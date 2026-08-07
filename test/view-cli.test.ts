import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runView } from "../src/cli/commands/view.js";
import { run } from "../src/cli/run.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-view-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runView", () => {
  it("writes a staleness-stamped mermaid view for C9 under .codeontic/ws/", async () => {
    await seedSyntheticModel(workDir);
    const result = await runView(workDir, "C9");

    expect(result.outputPath).toBe(join(workDir, ".codeontic", "ws", "view-C9.md"));
    expect(result.validation).toBeUndefined(); // validate not requested

    const written = await readFile(result.outputPath, "utf8");
    expect(written).toContain("<!-- codeontic-staleness-stamp");
    expect(written).toContain("model_content_hash:");
    expect(written).toContain("```mermaid");
    expect(written).toContain("flowchart TB");
    expect(written).toContain("J-synth-handoff: handoff");
  });

  it("throws a clear error for an unknown flow id, without writing a file", async () => {
    await seedSyntheticModel(workDir);
    await expect(runView(workDir, "C-DOES-NOT-EXIST")).rejects.toThrow(/no such flow/);
    await expect(
      readFile(join(workDir, ".codeontic", "ws", "view-C-DOES-NOT-EXIST.md")),
    ).rejects.toThrow();
  });

  it("with validate:true, actually renders via mmdc and reports a valid result", async () => {
    await seedSyntheticModel(workDir);
    const result = await runView(workDir, "C9", { validate: true });
    expect(result.validation).toEqual({ status: "valid" });
  }, 30_000);
});

describe("run() — `codeontic view` CLI dispatch", () => {
  it("view <flow-id> <dir> writes the file and exits 0", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    await seedSyntheticModel(workDir);
    const exitCode = await run(["view", "C9", workDir], io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("wrote") && l.includes("view-C9.md"))).toBe(true);
  });

  it("view with no <flow-id> exits 1 with a clear error, not a crash", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    const exitCode = await run(["view"], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.startsWith("ERR:") && l.includes("missing <flow-id>"))).toBe(true);
  });

  it("view <unknown-flow-id> <dir> exits 1 with the renderer's error surfaced", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    await seedSyntheticModel(workDir);
    const exitCode = await run(["view", "C-NOPE", workDir], io);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.startsWith("ERR:") && l.includes("no such flow"))).toBe(true);
  });

  it("view <flow-id> <dir> --validate reports validation ok and exits 0", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    await seedSyntheticModel(workDir);
    const exitCode = await run(["view", "C9", workDir, "--validate"], io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("mermaid validation: ok"))).toBe(true);
  }, 30_000);

  it("view <flow-id> --validate with NO <dir> positional treats --validate as a flag (not a bogus dir) and defaults to cwd", async () => {
    // parseFlags separates every "--"-prefixed token into `flags` regardless
    // of its position among positionals, so positionals[1] is undefined
    // here (not the literal string "--validate") — this locks that in for
    // the "view <flow-id> --validate" invocation shape specifically.
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };
    await seedSyntheticModel(workDir);
    const originalCwd = process.cwd();
    process.chdir(workDir);
    try {
      const exitCode = await run(["view", "C9", "--validate"], io);
      expect(exitCode).toBe(0);
      expect(logs.some((l) => l.includes("mermaid validation: ok"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  }, 30_000);
});
