import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp/server.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

let workDir: string;

/**
 * Extra topology (Proposal 010 — no target-repo seed ships with this engine)
 * for the model_plan/model_inspect assertions: C5 traverses [L97, L98], and
 * GWT-INV-004 (owner_match) applies to L98 without being hand-listed.
 */
async function addExtraNodes(dir: string): Promise<void> {
  const modelDir = join(dir, ".codeontic", "model");
  await writeFile(
    join(modelDir, "loops", "extra.yaml"),
    [
      "- id: L97",
      "  kind: loop",
      "  title: 合成 MCP 循环一",
      "  boundary: b",
      '  owner: "packages/mcp-owner"',
      "  anchors: [src/synth/l97.ts#L97]",
      "",
      "- id: L98",
      "  kind: loop",
      "  title: 合成 MCP 循环二(owner_match 命中)",
      "  boundary: b",
      '  owner: "packages/mcp-owner-invariant"',
      "  anchors: [src/synth/l98.ts#L98]",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "flows", "C5.yaml"),
    ["id: C5", "kind: flow", "title: 合成 MCP 流", "traverses: [L97, L98]"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(modelDir, "scenarios", "GWT-INV-004.yaml"),
    [
      "id: GWT-INV-004",
      "kind: scenario",
      "given: g",
      "when: w",
      "then: t",
      "level: contract",
      "applies_to:",
      '  owner_match: "packages/mcp-owner-invariant"',
    ].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-mcp-test-"));
  await seedSyntheticModel(workDir);
  await addExtraNodes(workDir);
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Wires a real MCP client to the codeontic server over an in-memory transport pair. */
async function connectedClient() {
  const server = buildMcpServer(workDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

/** Concatenate the text content of a tool result (SDK's CallToolResult union). */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("codeontic MCP server — real client over in-memory transport", () => {
  it("exposes the model_* query tools", async () => {
    const { client, server } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "model_evidence",
        "model_impact",
        "model_inspect",
        "model_matrix",
        "model_plan",
        "model_scenario",
        "model_search",
      ]);
      // each tool advertises a description + an input schema with `id`
      const plan = tools.find((t) => t.name === "model_plan");
      expect(plan?.description).toBeTruthy();
      expect(plan?.inputSchema?.properties).toHaveProperty("id");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("model_plan returns the C5 ordered sequence (summary + side-channel path)", async () => {
    const { client, server } = await connectedClient();
    try {
      const res = await client.callTool({ name: "model_plan", arguments: { id: "C5" } });
      const text = textOf(res);
      expect(text).toContain("L97 → L98");
      expect(text).toContain("full detail written to:");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("model_inspect slices around a node and reports effective constraints", async () => {
    const { client, server } = await connectedClient();
    try {
      const res = await client.callTool({
        name: "model_inspect",
        arguments: { id: "L98", depth: 1 },
      });
      const text = textOf(res);
      expect(text).toContain("inspect L98 (loop)");
      expect(text).toContain("GWT-INV-004"); // the invariant pulled in via applies_to
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports an unknown id as a tool error, not a crash", async () => {
    const { client, server } = await connectedClient();
    try {
      const res = await client.callTool({ name: "model_evidence", arguments: { id: "NOPE" } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/unknown/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
