import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allHostIds,
  getHost,
  instructionBody,
  mergeMcpServer,
  writeAgentHost,
} from "../src/hosts/registry.js";

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "codeontic-registry-test-"));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("instructionBody", () => {
  it("strips YAML frontmatter from SKILL content", () => {
    const body = instructionBody();
    expect(body).not.toContain("---");
    expect(body).toContain("codeontic");
    expect(body).toContain("model_inspect");
    expect(body.length).toBeGreaterThan(100);
  });
});

describe("host targets", () => {
  it("has known host ids", () => {
    const ids = allHostIds();
    expect(ids).toContain("agents");
    expect(ids).toContain("cursor");
    expect(ids).toContain("gemini");
    expect(ids).toContain("copilot");
  });

  it("cursor target has owned kind and mdc format", () => {
    const cursor = getHost("cursor");
    expect(cursor).toBeDefined();
    expect(cursor?.kind).toBe("owned");
    expect(cursor?.relPath).toContain(".mdc");
    const wrapped = cursor?.wrapContent("test body");
    expect(wrapped).toContain("alwaysApply: true");
    expect(wrapped).toContain("test body");
  });

  it("section targets wrap body as-is", () => {
    const agents = getHost("agents");
    expect(agents?.wrapContent("hello")).toBe("hello");
  });
});

describe("writeAgentHost", () => {
  it("creates section-kind instruction file with markers", async () => {
    const result = await writeAgentHost(repoDir, "agents", "0.5");
    expect(result.instruction).toBe("created");
    expect(result.mcp).toBeUndefined();

    const content = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    expect(content).toContain("codeontic:managed:start");
    expect(content).toContain("codeontic:managed:end");
    expect(content).toContain("model_inspect");
  });

  it("creates owned cursor file without markers", async () => {
    const result = await writeAgentHost(repoDir, "cursor", "0.5");
    expect(result.instruction).toBe("created");
    expect(result.mcp).toBe("created");

    const content = await readFile(join(repoDir, ".cursor/rules/codeontic.mdc"), "utf8");
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("model_inspect");
    expect(content).not.toContain("codeontic:managed:");

    const mcpContent = JSON.parse(await readFile(join(repoDir, ".cursor/mcp.json"), "utf8"));
    expect(mcpContent.mcpServers.codeontic.command).toBe("npx");
    expect(mcpContent.mcpServers.codeontic.args).toContain("codeontic@0.5");
  });

  it("is idempotent — second run returns unchanged", async () => {
    await writeAgentHost(repoDir, "cursor", "0.5");
    const result = await writeAgentHost(repoDir, "cursor", "0.5");
    expect(result.instruction).toBe("unchanged");
    expect(result.mcp).toBe("unchanged");
  });

  it("section-kind idempotent on second run", async () => {
    await writeAgentHost(repoDir, "agents", "0.5");
    const result = await writeAgentHost(repoDir, "agents", "0.5");
    expect(result.instruction).toBe("unchanged");
  });

  it("preserves user content outside managed section", async () => {
    await writeAgentHost(repoDir, "gemini", "0.5");
    const filePath = join(repoDir, "GEMINI.md");
    const original = await readFile(filePath, "utf8");
    const withUserContent = `# My custom instructions\n\n${original}`;
    await writeFile(filePath, withUserContent, "utf8");

    const result = await writeAgentHost(repoDir, "gemini", "0.5");
    expect(result.instruction).toBe("unchanged");

    const content = await readFile(filePath, "utf8");
    expect(content).toContain("My custom instructions");
  });

  it("creates gemini MCP config", async () => {
    const result = await writeAgentHost(repoDir, "gemini", "1");
    expect(result.mcp).toBe("created");

    const content = JSON.parse(await readFile(join(repoDir, ".gemini/settings.json"), "utf8"));
    expect(content.mcpServers.codeontic.args).toContain("codeontic@1");
  });

  it("throws for unknown host id", async () => {
    await expect(writeAgentHost(repoDir, "nonexistent", "0.5")).rejects.toThrow("unknown host");
  });
});

describe("mergeMcpServer", () => {
  it("creates new file when absent", async () => {
    const path = join(repoDir, ".mcp.json");
    const outcome = await mergeMcpServer(path, "0.5");
    expect(outcome).toBe("created");

    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.mcpServers.codeontic.command).toBe("npx");
  });

  it("merges into existing file preserving other servers", async () => {
    const path = join(repoDir, ".mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "other" } } }), "utf8");

    const outcome = await mergeMcpServer(path, "0.5");
    expect(outcome).toBe("merged");

    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.mcpServers.other.command).toBe("other");
    expect(content.mcpServers.codeontic.command).toBe("npx");
  });

  it("unchanged on equal config", async () => {
    const path = join(repoDir, ".mcp.json");
    await mergeMcpServer(path, "0.5");
    const outcome = await mergeMcpServer(path, "0.5");
    expect(outcome).toBe("unchanged");
  });

  it("skips unparseable JSON", async () => {
    const path = join(repoDir, ".mcp.json");
    await writeFile(path, "broken", "utf8");
    const outcome = await mergeMcpServer(path, "0.5");
    expect(outcome).toBe("skipped-unparseable");
  });
});

describe("owned host files are never silently overwritten (release-readiness finding)", () => {
  it("keeps a hand-edited owned file instead of clobbering it, and reports skipped-modified", async () => {
    // `.cursor/rules/codeontic.mdc` is an `owned` target. It used to be
    // rewritten wholesale on every `init --agents cursor` whose content
    // differed, reported only as `instruction → updated` — so a user who had
    // edited it lost those edits with no prompt and, for an uncommitted file,
    // no way back. Refusing to upgrade one file is strictly better than
    // destroying content, and matches the posture B1 already takes for a
    // managed file that has no markers.
    const dir = await mkdtemp(join(tmpdir(), "codeontic-owned-"));
    try {
      const rel = ".cursor/rules/codeontic.mdc";
      await mkdir(join(dir, ".cursor", "rules"), { recursive: true });
      const mine = "---\nalwaysApply: true\n---\n\nMY TEAM RULE — must survive\n";
      await writeFile(join(dir, rel), mine, "utf8");

      const result = await writeAgentHost(dir, "cursor", "0.8");
      expect(result.instruction).toBe("skipped-modified");
      // The bytes are untouched — this is the assertion that actually matters.
      expect(await readFile(join(dir, rel), "utf8")).toBe(mine);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat an unreadable-but-present file as absent (only ENOENT means absent)", async () => {
    // `readFile(...).catch(() => undefined)` used to swallow EVERY read error,
    // so an EACCES/EISDIR file read as "not there" and the next line truncated
    // it — the same data loss, reached through a different door. A directory
    // at the target path reproduces a non-ENOENT read error portably.
    const dir = await mkdtemp(join(tmpdir(), "codeontic-owned-eisdir-"));
    try {
      await mkdir(join(dir, ".cursor", "rules", "codeontic.mdc"), { recursive: true });
      await expect(writeAgentHost(dir, "cursor", "0.8")).rejects.toThrow();
      // Still a directory — nothing was clobbered on the way past.
      expect((await stat(join(dir, ".cursor/rules/codeontic.mdc"))).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still creates the owned file when it does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-owned-new-"));
    try {
      const result = await writeAgentHost(dir, "cursor", "0.8");
      expect(result.instruction).toBe("created");
      expect(await readFile(join(dir, ".cursor/rules/codeontic.mdc"), "utf8")).toContain(
        "alwaysApply",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
