import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runInspect } from "../cli/commands/inspect.js";
import { loadModel } from "../loader/load-model.js";
import { type QueryCommand, runQuery } from "../query/run-query.js";
import { runSearchCommand } from "../query/search.js";

/**
 * The codeontic stdio MCP server (Proposal 006 B4 / 001 §0 §8): a few-entry
 * query surface that hands an Agent task-relevant model slices, so it doesn't
 * have to read the whole spec. Every tool follows the 001 §4.2 side-channel
 * shape — the response is a compact SUMMARY plus the path to a full workspace
 * file — keeping tool responses small while the detail stays retrievable.
 *
 * All tools are read-only model queries (no repoRoot, no code scan, no LLM).
 * `targetDir` (the dir holding `.codeontic/model/`) is fixed at server start.
 */

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

export function buildMcpServer(targetDir: string): McpServer {
  const server = new McpServer({ name: "codeontic", version: "0.1.0" });

  const render = (r: { summary: string; outputPath: string; staleWarning?: string }) =>
    toolResult(
      `${r.staleWarning ? `⚠ ${r.staleWarning}\n\n` : ""}${r.summary}\n\nfull detail written to: ${r.outputPath}`,
    );

  server.registerTool(
    "model_inspect",
    {
      description:
        "Slice the behavioral model around a node id (flow C1.., loop L1.., junction J-.., scenario GWT-..). Returns a summary (node skeletons + child counts + effective constraints) plus a side-channel file with the full slice. Use this first to orient on an unfamiliar part of the system.",
      inputSchema: { id: z.string(), depth: z.number().int().min(0).optional() },
    },
    async ({ id, depth }) => {
      try {
        return render(await runInspect(targetDir, id, depth != null ? { depth } : {}));
      } catch (err) {
        return toolResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  const queryTool = (name: string, command: QueryCommand, description: string) =>
    server.registerTool(
      `model_${name}`,
      { description, inputSchema: { id: z.string() } },
      async ({ id }) => {
        try {
          return render(await runQuery(targetDir, command, id));
        } catch (err) {
          return toolResult(err instanceof Error ? err.message : String(err), true);
        }
      },
    );

  queryTool(
    "impact",
    "impact",
    "Reverse-dependency blast radius of a node: everything that references it (which flows traverse a loop, which junctions sit between it, which scenarios constrain it). Use before changing a node to see what must be re-checked.",
  );
  queryTool(
    "plan",
    "plan",
    "A flow's ordered execution plan (id like C1): the traverses sequence, watchdog guards, and crossing junctions with their risk classes and endpoints. Use to understand how one end-to-end flow runs.",
  );
  queryTool(
    "scenario",
    "scenario",
    "A GWT scenario's full detail (id like GWT-C1-001): given/when/then, the tests that verify it, which loops/junctions reference it, and (for invariants) the loops it applies to.",
  );
  queryTool(
    "evidence",
    "evidence",
    "A node's grounding: a junction's typed evidence anchors (code/spec/issue/test) with notes, or a loop's code anchors, plus the scenarios bound to it.",
  );
  queryTool(
    "matrix",
    "matrix",
    "A flow's GWT↔test coverage matrix (id like C1): every scenario reachable from the flow, the tests it's bound to, and whether it's verified — the flow's test-coverage surface at a glance.",
  );

  server.registerTool(
    "model_search",
    {
      description:
        "Free-text search over the behavioral model. Returns scored hits (title/id ×3, anchors ×2, body ×1, IDF-weighted) plus 1-hop related nodes. When the result has ≤3 hits, use model_inspect on the top hit or model_overview to browse — rephrasing the same search rarely helps.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      try {
        const modelDir = join(targetDir, ".codeontic", "model");
        const load = await loadModel(modelDir);
        if (load.parseErrors.length > 0) {
          throw new Error(
            `model has ${load.parseErrors.length} parse error(s) — run "codeontic check" first`,
          );
        }
        const result = await runSearchCommand(targetDir, query, load.graph);
        return toolResult(
          `${result.staleWarning ? `⚠ ${result.staleWarning}\n\n` : ""}${result.summary}\n\nfull detail written to: ${result.outputPath}`,
        );
      } catch (err) {
        return toolResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  return server;
}

/** Starts the server on stdio (the shape an MCP client launches: `codeontic mcp <dir>`). */
export async function startMcpServer(targetDir: string): Promise<void> {
  const server = buildMcpServer(targetDir);
  await server.connect(new StdioServerTransport());
}
