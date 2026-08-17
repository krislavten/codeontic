import { join } from "node:path";
import { loadModel } from "../../loader/load-model.js";
import { type SearchResult, runSearchCommand } from "../../query/search.js";

/**
 * `codeontic search "<query>" [dir]`: free-text IDF search over the model,
 * CLI twin of the `model_search` MCP tool. It exists because the MCP server
 * is a transport only Claude-Code-style hosts can mount — agents that reach
 * codeontic through a shell (the AGENTS.md path, the universal integration
 * surface) had every query command EXCEPT the entry-point finder, leaving
 * them to grep node titles by hand. Same loader guard as the other query
 * commands: a model with parse errors refuses to search rather than silently
 * searching a partial graph.
 */
export async function runSearchCli(targetDir: string, query: string): Promise<SearchResult> {
  const load = await loadModel(join(targetDir, ".codeontic", "model"));
  if (load.parseErrors.length > 0) {
    throw new Error(
      `model has ${load.parseErrors.length} parse error(s) — run "codeontic check" first`,
    );
  }
  return runSearchCommand(targetDir, query, load.graph);
}
