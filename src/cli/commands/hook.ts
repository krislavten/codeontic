import { relative, resolve } from "node:path";
import { loadModel } from "../../loader/load-model.js";
import { getNode } from "../../loader/model-graph.js";
import { affectedNodes } from "../../query/diff.js";

const MODEL_DIR = ".codeontic/model";
const CODEONTIC_PREFIX = ".codeontic/";

export type HookEvent = "post-edit" | "session-start";

/**
 * Handle the `post-edit` hook event (PostToolUse on Write|Edit|MultiEdit).
 * Returns context to inject when the edited file is model-anchored, empty
 * string otherwise.
 *
 * Fail-soft: callers catch errors and exit 0 with empty output.
 */
export async function runHookPostEdit(targetDir: string, stdinPayload: string): Promise<string> {
  let filePath: string | undefined;
  try {
    const parsed = JSON.parse(stdinPayload) as {
      tool_input?: { file_path?: string };
    };
    filePath = parsed?.tool_input?.file_path;
  } catch {
    return "";
  }
  if (!filePath) return "";

  const absTarget = resolve(targetDir);
  const absFile = resolve(filePath);
  const relFile = relative(absTarget, absFile).replace(/\\/g, "/");

  if (relFile.startsWith(CODEONTIC_PREFIX)) return "";
  if (relFile.startsWith("..")) return "";

  // No model in this repo → hook is a silent no-op, not a per-edit error.
  let load: Awaited<ReturnType<typeof loadModel>>;
  try {
    load = await loadModel(resolve(targetDir, MODEL_DIR));
  } catch {
    return "";
  }
  if (load.graph.byKind.loop.size === 0 && load.graph.byKind.flow.size === 0) return "";

  const affected = affectedNodes(load.graph, [relFile]);
  if (affected.length === 0) return "";

  const lines: string[] = ["[codeontic] This file is model-anchored:"];
  for (const a of affected) {
    const node = getNode(load.graph, a.nodeId);
    if (!node) continue;
    let detail = `  ${a.nodeId} (${a.kind})`;
    if (node.kind === "loop") detail += ` "${node.title}" — boundary: ${node.boundary}`;
    else if (node.kind === "flow") detail += ` "${node.title}"`;
    else if (node.kind === "junction") detail += node.title ? ` "${node.title}"` : "";
    lines.push(detail);
  }
  lines.push("Run `codeontic check . --diff <base>` before committing.");
  return lines.join("\n");
}

/**
 * Handle the `session-start` hook event (SessionStart). Returns a compact
 * model overview + MCP tool catalogue for the agent's context window.
 * SessionStart output enters the cache and is paid once — can be detailed.
 */
export async function runHookSessionStart(targetDir: string): Promise<string> {
  // No model in this repo → silent no-op (a session in a non-codeontic repo
  // must not see an error on every start).
  let load: Awaited<ReturnType<typeof loadModel>>;
  try {
    load = await loadModel(resolve(targetDir, MODEL_DIR));
  } catch {
    return "";
  }
  const { loop, flow, junction, scenario } = load.graph.byKind;

  if (loop.size === 0 && flow.size === 0) return "";

  const lines: string[] = [
    `[codeontic] Model loaded: ${flow.size} flow(s), ${loop.size} loop(s), ${junction.size} junction(s), ${scenario.size} scenario(s)`,
    "",
  ];

  if (flow.size > 0) {
    lines.push("Flows:");
    for (const f of flow.values()) {
      const traverses = f.traverses.length > 0 ? ` — traverses: ${f.traverses.join(", ")}` : "";
      lines.push(`  ${f.id} "${f.title}" [${f.status}]${traverses}`);
    }
    lines.push("");
  }

  lines.push(
    "MCP tools (start with `codeontic mcp`):",
    "  model_inspect <id>  — slice the model around a node",
    "  model_impact <id>   — what changing this node might affect",
    "  model_plan <id>     — implementation checklist",
    "  model_scenario <id> — scenarios that verify this node",
    "  model_evidence <id> — evidence and test anchors",
    "  model_matrix <id>   — cross-reference matrix for a flow",
    "  model_search <text> — free-text search over the model",
    "",
    "Call discipline: query the model before modifying model-anchored code.",
    "Run `codeontic check . --diff <base>` before committing.",
  );

  return lines.join("\n");
}
