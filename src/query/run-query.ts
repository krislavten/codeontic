import { join } from "node:path";
import { loadModel } from "../loader/load-model.js";
import type { ModelGraph } from "../loader/model-graph.js";
import { scenarioTestAnchorLabels } from "../schema/model.js";
import {
  type EvidenceResult,
  type ImpactResult,
  type PlanResult,
  type ScenarioResult,
  type TestMatrixResult,
  evidenceOf,
  impactOf,
  planOf,
  scenarioDetail,
  testMatrix,
} from "./queries.js";
import { writeSideChannel } from "./side-channel.js";

/**
 * The Phase-2 query command runner (Proposal 006 B4): loads the model, runs one
 * focused query, writes a staleness-stamped side-channel file, and returns a
 * compact summary + the file path — the 001 §4.2 shape shared by CLI and MCP.
 * `inspect` has its own runner (A5); this covers impact/plan/scenario/evidence.
 */

export type QueryCommand = "impact" | "plan" | "scenario" | "evidence" | "matrix";

export interface QueryResult {
  command: QueryCommand;
  id: string;
  outputPath: string;
  summary: string;
  staleWarning?: string;
}

interface Rendered {
  summary: string;
  body: string;
}

function renderImpact(r: ImpactResult): Rendered {
  const byRelation: Record<string, string[]> = {};
  for (const d of r.dependents) {
    const list = byRelation[d.relation] ?? [];
    list.push(`${d.id}(${d.kind})`);
    byRelation[d.relation] = list;
  }
  const summary = [
    `impact ${r.nodeId} (${r.kind}) — ${r.dependents.length} dependent(s):`,
    ...Object.entries(byRelation).map(([rel, ids]) => `  via ${rel}: ${ids.join(", ")}`),
  ].join("\n");
  const body = [
    `# impact ${r.nodeId} (${r.kind})`,
    "",
    `${r.dependents.length} node(s) reference it — changing ${r.nodeId} may force re-checking these:`,
    "",
    ...r.dependents.map((d) => `- ${d.id} (${d.kind}) — ${d.relation}`),
  ].join("\n");
  return { summary, body };
}

function renderPlan(r: PlanResult): Rendered {
  const seq = r.steps.map((s) => s.loopId).join(" → ") || "(no traverses)";
  const summary = [
    `plan ${r.flowId} — ${r.title}`,
    `  sequence: ${seq}`,
    `  guards: ${r.guards.map((g) => g.loopId).join(", ") || "(none)"}`,
    `  junctions: ${r.junctions.map((j) => `${j.id}[${j.risk_class}]`).join(", ") || "(none)"}`,
    r.subFlows.length ? `  sub-flows: ${r.subFlows.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = [
    `# plan ${r.flowId} — ${r.title}`,
    "",
    "## ordered steps",
    "",
    ...r.steps.map((s, i) => {
      const head = `${i + 1}. **${s.loopId}** ${s.title} [${s.status}]`;
      return s.effectiveConstraints.length
        ? `${head}\n   - invariants (applies_to): ${s.effectiveConstraints.join(", ")}`
        : head;
    }),
    "",
    "## guards (watchdogs)",
    "",
    ...(r.guards.length ? r.guards.map((g) => `- ${g.loopId} ${g.title}`) : ["(none)"]),
    "",
    "## crossing junctions",
    "",
    ...(r.junctions.length
      ? r.junctions.map(
          (j) =>
            `- ${j.id} [${j.risk_class}] ${j.between.join("→")}${j.title ? ` — ${j.title}` : ""}`,
        )
      : ["(none)"]),
    r.subFlows.length ? `\n## sub-flows\n\n${r.subFlows.map((f) => `- ${f}`).join("\n")}` : "",
  ].join("\n");
  return { summary, body };
}

function renderScenario(r: ScenarioResult): Rendered {
  const s = r.scenario;
  const refs = r.referencedBy.map((x) => `${x.id}(${x.kind})`).join(", ") || "(none)";
  const summary = [
    `scenario ${s.id} [${s.level}] — verified_by ${scenarioTestAnchorLabels(s).length} test(s)`,
    `  referenced by: ${refs}`,
    r.appliesToLoops.length ? `  applies to loops: ${r.appliesToLoops.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = [
    `# scenario ${s.id} [${s.level}]`,
    "",
    `- **given** ${s.given}`,
    `- **when** ${s.when}`,
    `- **then** ${s.then}`,
    `- **verified_by**: ${scenarioTestAnchorLabels(s).join(", ") || "(none — unverified)"}`,
    s.applies_to
      ? `- **applies_to**: nodes=[${s.applies_to.nodes.join(", ")}]${s.applies_to.owner_match ? ` owner_match="${s.applies_to.owner_match}"` : ""}`
      : "",
    "",
    `## referenced by\n\n${r.referencedBy.length ? r.referencedBy.map((x) => `- ${x.id} (${x.kind})`).join("\n") : "(none)"}`,
    r.appliesToLoops.length
      ? `\n## applies to loops (resolved)\n\n${r.appliesToLoops.map((l) => `- ${l}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { summary, body };
}

function renderEvidence(r: EvidenceResult): Rendered {
  const summary = [
    `evidence ${r.nodeId} (${r.kind}) — ${r.evidence.length} evidence, ${r.anchors.length} anchor(s), ${r.scenarios.length} scenario(s)`,
    ...r.evidence.map((e) => `  [${e.kind}] ${e.anchor}`),
    ...r.anchors.map((a) => `  anchor: ${a}`),
  ].join("\n");
  const body = [
    `# evidence ${r.nodeId} (${r.kind})`,
    "",
    r.evidence.length ? "## evidence" : "",
    ...r.evidence.map((e) => `- [${e.kind}] \`${e.anchor}\`${e.note ? ` — ${e.note}` : ""}`),
    r.anchors.length ? "\n## anchors" : "",
    ...r.anchors.map((a) => `- \`${a}\``),
    r.scenarios.length
      ? `\n## bound scenarios\n\n${r.scenarios.map((x) => `- ${x}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { summary, body };
}

function renderMatrix(r: TestMatrixResult): Rendered {
  const unknownNote = r.summary.unknownScenario
    ? ` (⚠ ${r.summary.unknownScenario} dangling scenario ref)`
    : "";
  const summary = [
    `matrix ${r.flowId} — ${r.title}`,
    `  ${r.summary.total} GWT: ${r.summary.verified} verified / ${r.summary.unverified} unverified${unknownNote}`,
  ].join("\n");
  const body = [
    `# test matrix ${r.flowId} — ${r.title}`,
    "",
    `${r.summary.total} scenarios · ${r.summary.verified} verified · ${r.summary.unverified} unverified${unknownNote}`,
    "",
    "| GWT | level | verified | verified_by | referenced by |",
    "|---|---|---|---|---|",
    ...r.rows.map(
      (row) =>
        `| ${row.scenarioId} | ${row.level} | ${row.verified ? "✅" : "—"} | ${
          // "; "-separated so the cell stays readable as plain text (not just rendered)
          row.verifiedBy.length ? row.verifiedBy.map((v) => `\`${v}\``).join("; ") : "(none)"
        } | ${row.referencedBy.join(", ")} |`,
    ),
    "",
  ].join("\n");
  return { summary, body };
}

function render(command: QueryCommand, graph: ModelGraph, id: string): Rendered | undefined {
  switch (command) {
    case "impact": {
      const r = impactOf(graph, id);
      return r && renderImpact(r);
    }
    case "plan": {
      const r = planOf(graph, id);
      return r && renderPlan(r);
    }
    case "scenario": {
      const r = scenarioDetail(graph, id);
      return r && renderScenario(r);
    }
    case "evidence": {
      const r = evidenceOf(graph, id);
      return r && renderEvidence(r);
    }
    case "matrix": {
      const r = testMatrix(graph, id);
      return r && renderMatrix(r);
    }
  }
}

export async function runQuery(
  targetDir: string,
  command: QueryCommand,
  id: string,
): Promise<QueryResult> {
  const load = await loadModel(join(targetDir, ".codeontic", "model"));
  if (load.parseErrors.length > 0) {
    throw new Error(
      `model has ${load.parseErrors.length} parse error(s) — run "codeontic check" first`,
    );
  }
  const rendered = render(command, load.graph, id);
  if (!rendered) {
    const expected =
      command === "plan" || command === "matrix"
        ? "flow"
        : command === "scenario"
          ? "scenario"
          : "node";
    throw new Error(`unknown ${expected} id "${id}" for \`${command}\``);
  }
  const { outputPath, staleWarning } = await writeSideChannel(
    targetDir,
    `${command}-${id}`,
    (banner) => `${banner}\n\n${rendered.body}\n`,
  );
  return {
    command,
    id,
    outputPath,
    summary: `${rendered.summary}\n  (full detail: ${outputPath})`,
    ...(staleWarning ? { staleWarning } : {}),
  };
}
