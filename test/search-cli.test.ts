import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSearchCli } from "../src/cli/commands/search.js";
import { run } from "../src/cli/run.js";
import { loadModel } from "../src/loader/load-model.js";
import { runSearchCommand } from "../src/query/search.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-search-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runSearchCli", () => {
  it("finds nodes by title text and writes a staleness-stamped side-channel file", async () => {
    await seedSyntheticModel(workDir);
    const result = await runSearchCli(workDir, "合成交接");

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.id === "J-synth-handoff")).toBe(true);
    expect(result.summary).toContain("J-synth-handoff");

    const written = await readFile(result.outputPath, "utf8");
    expect(written).toContain("<!-- codeontic-staleness-stamp");
    expect(written).toContain("model_content_hash:");
  });

  it("a pure-CJK query still gets a non-empty side-channel tag (no filename collision washout)", async () => {
    await seedSyntheticModel(workDir);
    const result = await runSearchCli(workDir, "合成主循环");
    // The basename must carry query-derived content, not collapse to "search-".
    expect(result.outputPath).toMatch(/search-.+\.md$/);
  });

  it("refuses to search a model with parse errors instead of searching a partial graph", async () => {
    await seedSyntheticModel(workDir);
    await writeFile(join(workDir, ".codeontic", "model", "broken.yaml"), "id: [not\n");
    await expect(runSearchCli(workDir, "合成")).rejects.toThrow(/parse error/);
  });
});

describe("run() — `codeontic search` CLI dispatch", () => {
  it('search "<query>" <dir> prints the summary + output path and exits 0', async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    await seedSyntheticModel(workDir);
    const exitCode = await run(["search", "合成交接", workDir], io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("J-synth-handoff"))).toBe(true);
    expect(logs.some((l) => l.includes("wrote") && l.includes("search-"))).toBe(true);
  });

  it("missing query exits 1 with usage", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    const exitCode = await run(["search"], io);

    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.startsWith("ERR:") && l.includes("missing <query>"))).toBe(true);
  });

  it("low-hit guidance names CLI commands, not MCP tool names (model_inspect)", async () => {
    await seedSyntheticModel(workDir);
    const result = await runSearchCli(workDir, "合成交接");
    expect(result.hits.filter((h) => !h.related).length).toBeLessThanOrEqual(3);
    expect(result.summary).not.toContain("model_inspect");
    expect(result.summary).toContain("inspect <id>");
  });

  it("guidance speaks the caller's vocabulary: mcp naming says model_inspect, cli naming never does", async () => {
    const modelDir = await seedSyntheticModel(workDir);
    const load = await loadModel(modelDir);
    const viaMcp = await runSearchCommand(workDir, "合成交接", load.graph, "mcp");
    expect(viaMcp.summary).toContain("model_inspect");
    expect(viaMcp.summary).not.toContain(" inspect <id>");
    const viaCli = await runSearchCli(workDir, "合成交接");
    expect(viaCli.summary).toContain("inspect <id>");
    expect(viaCli.summary).not.toContain("model_inspect");
  });

  it("mcp guidance never names a tool the MCP server does not register (no model_overview)", async () => {
    const modelDir = await seedSyntheticModel(workDir);
    const load = await loadModel(modelDir);
    // Both guidance branches: zero hits and the ≤3-hit tail.
    for (const q of ["xyznonexistent", "合成交接"]) {
      const viaMcp = await runSearchCommand(workDir, q, load.graph, "mcp");
      expect(viaMcp.summary).not.toContain("model_overview");
    }
  });

  it("exactly-two-words-no-dir gets the quote guidance, not a bare run-init instruction", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    const exitCode = await run(["search", "session", "revive"], io);

    expect(exitCode).toBe(1);
    const err = logs.find((l) => l.startsWith("ERR:"));
    expect(err).toContain('quote it: codeontic search "session revive" [dir]');
    expect(err).toContain("does not exist");
  });

  it("a second word that IS a real dir but carries no model is still offered as a query word", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    await seedSyntheticModel(workDir);
    // A model-less sibling directory named like a plausible query word — the
    // case bare existsSync let through into loadModel's misleading error.
    await mkdir(join(workDir, "docs"));
    const exitCode = await run(["search", "session", join(workDir, "docs")], io);

    expect(exitCode).toBe(1);
    const err = logs.find((l) => l.startsWith("ERR:"));
    expect(err).toContain("has no .codeontic/model");
    expect(err).toContain('quote it: codeontic search "session');
  });

  it("a second positional that IS a searchable dir is used as the target, not rejected", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    await seedSyntheticModel(workDir);
    const exitCode = await run(["search", "合成交接", workDir], io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("J-synth-handoff"))).toBe(true);
  });

  it("a trailing arg that is an existing FILE stays inside the suggested quoted query (not treated as dir)", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    await seedSyntheticModel(workDir);
    const filePath = join(workDir, "README.md");
    await writeFile(filePath, "readme\n");
    const exitCode = await run(["search", "update", "the", filePath], io);

    expect(exitCode).toBe(1);
    const err = logs.find((l) => l.startsWith("ERR:"));
    expect(err).toContain(`"update the ${filePath}"`);
    expect(err).toContain("[dir]");
  });

  it("an unquoted multi-word query is named as such, not folded into a generic usage error", async () => {
    const logs: string[] = [];
    const io = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(`ERR:${l}`) };

    await seedSyntheticModel(workDir);
    const exitCode = await run(["search", "session", "revive", workDir], io);

    expect(exitCode).toBe(1);
    const err = logs.find((l) => l.startsWith("ERR:"));
    expect(err).toBeDefined();
    expect(err).toContain("quote a multi-word query");
    expect(err).toContain('"session revive"');
  });
});
