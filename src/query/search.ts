import type { ModelGraph } from "../loader/model-graph.js";
import { allNodes, getNode } from "../loader/model-graph.js";
import type { ModelNode } from "../schema/index.js";
import { impactOf } from "./queries.js";
import { type SideChannelResult, writeSideChannel } from "./side-channel.js";

const TOP_N = 10;

export interface SearchHit {
  id: string;
  kind: ModelNode["kind"];
  title: string;
  score: number;
  related?: boolean;
}

export interface SearchResult extends SideChannelResult {
  query: string;
  hits: SearchHit[];
  summary: string;
}

/**
 * Tokenize a query string: camelCase split, lowercase, drop single-char tokens.
 * Adopted from Graft's tokenizer semantics.
 */
export function tokenize(text: string): string[] {
  const tokens = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9一-鿿]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return [...new Set(tokens)];
}

function nodeTitle(node: ModelNode): string {
  switch (node.kind) {
    case "feature":
    case "flow":
    case "loop":
      return node.title;
    case "junction":
      return node.title ?? "";
    case "scenario":
      return node.given;
    case "debt":
      return node.subject;
  }
}

function nodeSearchFields(node: ModelNode): {
  title: string;
  id: string;
  paths: string[];
  body: string[];
} {
  const title = nodeTitle(node);
  const paths: string[] = [];
  const body: string[] = [];

  if (node.kind === "loop") {
    paths.push(...node.anchors);
    if (node.owner) body.push(node.owner);
    body.push(node.boundary);
    if (node.notes) body.push(node.notes);
  } else if (node.kind === "flow") {
    paths.push(...node.anchors);
    if (node.summary) body.push(node.summary);
  } else if (node.kind === "junction") {
    body.push(...node.between);
  } else if (node.kind === "scenario") {
    body.push(node.when, node.then);
    // Symbol anchors are path-searchable as written; a text anchor's path is
    // its `file`, and its quoted title belongs in the prose body.
    paths.push(...node.verified_by, ...node.verified_by_text.map((t) => t.file));
    body.push(...node.verified_by_text.map((t) => t.text));
  } else if (node.kind === "debt") {
    body.push(node.reality);
    if (node.claim) body.push(node.claim);
  }

  return { title, id: node.id, paths, body };
}

/**
 * Score a node against query tokens. Weights: title/id ×3, owner/anchors ×2,
 * boundary/summary/notes ×1. Query tokens are binary (each token contributes
 * at most once per field group — prevents long queries from amplifying
 * repeated words, adopted from Graft's empirical finding).
 */
function scoreNode(
  node: ModelNode,
  queryTokens: string[],
  idfWeights: Map<string, number>,
): number {
  if (queryTokens.length === 0) return 0;

  const fields = nodeSearchFields(node);
  const titleText = `${fields.title} ${fields.id}`.toLowerCase();
  const pathText = fields.paths.join(" ").toLowerCase();
  const bodyText = fields.body.join(" ").toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    const idf = idfWeights.get(token) ?? 1;
    if (titleText.includes(token)) score += 3 * idf;
    if (pathText.includes(token)) score += 2 * idf;
    if (bodyText.includes(token)) score += 1 * idf;
  }

  return score;
}

function computeIdf(nodes: ModelNode[], tokens: string[]): Map<string, number> {
  const N = nodes.length;
  if (N === 0) return new Map();

  const docFreq = new Map<string, number>();
  for (const node of nodes) {
    const fields = nodeSearchFields(node);
    const text =
      `${fields.title} ${fields.id} ${fields.paths.join(" ")} ${fields.body.join(" ")}`.toLowerCase();
    for (const token of tokens) {
      if (text.includes(token)) {
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }
  }

  const weights = new Map<string, number>();
  for (const token of tokens) {
    const df = docFreq.get(token) ?? 0;
    weights.set(token, df > 0 ? Math.log(N / df) + 1 : 1);
  }
  return weights;
}

/**
 * Run a text search over the model graph. Returns scored hits with 1-hop
 * expansion of top results marked as `related`.
 */
export function runSearch(graph: ModelGraph, query: string): { query: string; hits: SearchHit[] } {
  const tokens = tokenize(query);
  const nodes = allNodes(graph);
  const idfWeights = computeIdf(nodes, tokens);

  const scored: { node: ModelNode; score: number }[] = [];
  for (const node of nodes) {
    const score = scoreNode(node, tokens, idfWeights);
    if (score > 0) scored.push({ node, score });
  }

  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

  const directHits = scored.slice(0, TOP_N);
  const directIds = new Set(directHits.map((h) => h.node.id));

  // 1-hop expansion: for each direct hit, collect related nodes via impactOf
  const relatedHits: SearchHit[] = [];
  for (const hit of directHits) {
    const impact = impactOf(graph, hit.node.id);
    if (!impact) continue;
    for (const dep of impact.dependents) {
      if (directIds.has(dep.id)) continue;
      if (relatedHits.some((r) => r.id === dep.id)) continue;
      const depNode = getNode(graph, dep.id);
      relatedHits.push({
        id: dep.id,
        kind: dep.kind,
        title: depNode ? nodeTitle(depNode) : dep.id,
        score: 0,
        related: true,
      });
    }
  }

  const hits: SearchHit[] = [
    ...directHits.map((h) => ({
      id: h.node.id,
      kind: h.node.kind,
      title: nodeTitle(h.node),
      score: h.score,
    })),
    ...relatedHits,
  ];

  return { query, hits };
}

/**
 * Which command vocabulary the guidance lines speak. renderSummary serves BOTH
 * transports (the CLI `search` command and the `model_search` MCP tool return
 * this same string), and the follow-up commands are named differently on each
 * side (`inspect` vs `model_inspect`). Guidance that names the other side's
 * commands sends the reader to a tool that does not exist in their context —
 * exactly the bug this parameter removes; a single "neutral" wording cannot
 * fix that, because any concrete command name is transport-specific.
 */
export type SearchNaming = "cli" | "mcp";

/**
 * Each side may name ONLY what exists on that side. The two are not a rename of
 * one another: the CLI has an `overview` command, the MCP server registers no
 * `model_overview` tool (mcp/server.ts: inspect/impact/plan/scenario/evidence/
 * matrix/search), so the MCP guidance names `model_inspect` alone rather than a
 * tool the caller cannot invoke. Whole clauses, not a tool-name pair, because
 * that difference changes the sentence and not just a word in it.
 */
const NAMING_VOCAB: Record<SearchNaming, { browse: string; fewHits: string }> = {
  cli: {
    browse: "Try different terms, or browse with inspect/overview.",
    fewHits: "use inspect <id> or overview instead of rephrasing",
  },
  mcp: {
    browse: "Try different terms, or browse with model_inspect.",
    fewHits: "use model_inspect <id> instead of rephrasing",
  },
};

function renderSummary(query: string, hits: SearchHit[], naming: SearchNaming): string {
  const vocab = NAMING_VOCAB[naming];
  const direct = hits.filter((h) => !h.related);
  const related = hits.filter((h) => h.related);

  if (direct.length === 0) {
    return `search "${query}": 0 hits\nNo model nodes matched. ${vocab.browse}`;
  }

  const lines: string[] = [
    `search "${query}": ${direct.length} hit(s)${related.length > 0 ? ` + ${related.length} related` : ""}`,
    "",
  ];
  for (const h of direct) {
    lines.push(`  ${h.id} (${h.kind}) "${h.title}" — score ${h.score.toFixed(1)}`);
  }
  if (related.length > 0) {
    lines.push("", "Related (1-hop):");
    for (const h of related) {
      lines.push(`  ${h.id} (${h.kind}) "${h.title}"`);
    }
  }

  if (direct.length <= 3) {
    lines.push("", `Few hits — if this doesn't cover what you need, ${vocab.fewHits}.`);
  }

  return lines.join("\n");
}

function renderBody(query: string, hits: SearchHit[], banner: string): string {
  const lines: string[] = [
    banner,
    "",
    `# search: "${query}"`,
    "",
    `${hits.filter((h) => !h.related).length} direct hit(s), ${hits.filter((h) => h.related).length} related.`,
    "",
  ];

  const direct = hits.filter((h) => !h.related);
  if (direct.length > 0) {
    lines.push("## Hits", "");
    for (const h of direct) {
      lines.push(`### ${h.id} (${h.kind}) — score ${h.score.toFixed(1)}`, "");
      lines.push(`**${h.title}**`, "");
    }
  }

  const related = hits.filter((h) => h.related);
  if (related.length > 0) {
    lines.push("## Related (1-hop expansion)", "");
    for (const h of related) {
      lines.push(`- ${h.id} (${h.kind}) "${h.title}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runSearchCommand(
  targetDir: string,
  query: string,
  graph: ModelGraph,
  naming: SearchNaming = "cli",
): Promise<SearchResult> {
  const { hits } = runSearch(graph, query);
  const summary = renderSummary(query, hits, naming);
  // Keep CJK chars: a pure-CJK query must not wash out to an empty tag
  // (all such queries would collide on the same side-channel file).
  const hash = query
    .replace(/[^a-zA-Z0-9一-鿿]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  const sideChannel = await writeSideChannel(targetDir, `search-${hash}`, (banner) =>
    renderBody(query, hits, banner),
  );

  return { query, hits, summary, ...sideChannel };
}
