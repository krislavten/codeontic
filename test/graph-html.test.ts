import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli/run.js";
import { buildGraph } from "../src/loader/model-graph.js";
import { computeConformance } from "../src/query/conformance.js";
import type { Feature, Flow, Junction, Loop, Scenario } from "../src/schema/index.js";
import { computeGraphModel, renderGraphHtml } from "../src/views/graph-html.js";
import { seedSyntheticModel } from "./support/seed-synthetic-model.js";

function loop(overrides: Partial<Loop> & Pick<Loop, "id">): Loop {
  return {
    kind: "loop",
    title: "a loop",
    boundary: "x→y",
    owner: "packages/example",
    status: "unverified",
    anchors: [],
    consumes_queues: [],
    scenarios: [],
    ...overrides,
  };
}

function flow(overrides: Partial<Flow> & Pick<Flow, "id">): Flow {
  return {
    kind: "flow",
    title: "a flow",
    traverses: [],
    guarded_by: [],
    crosses: [],
    references: [],
    anchors: [],
    scenarios: [],
    status: "unverified",
    ...overrides,
  };
}

function feature(overrides: Partial<Feature> & Pick<Feature, "id">): Feature {
  return { kind: "feature", title: "a feature", contains: [], status: "unverified", ...overrides };
}

function junction(overrides: Partial<Junction> & Pick<Junction, "id" | "between">): Junction {
  return {
    kind: "junction",
    risk_class: "handoff",
    scenarios: [],
    evidence: [],
    status: "unverified",
    ...overrides,
  };
}

function scenario(overrides: Partial<Scenario> & Pick<Scenario, "id">): Scenario {
  return {
    kind: "scenario",
    given: "g",
    when: "w",
    // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
    then: "t",
    level: "unit",
    verified_by: [],
    verified_by_text: [],
    ...overrides,
  };
}

describe("computeGraphModel — nodes, edges, coloring", () => {
  it("colors loops/junctions by conformance verdict; flows/features are structural", () => {
    const { graph } = buildGraph([
      { file: "0", node: feature({ id: "F-x", contains: ["C1"] }) },
      { file: "a", node: flow({ id: "C1", traverses: ["L1", "L2"], crosses: ["J-h"] }) },
      { file: "b", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      { file: "c", node: loop({ id: "L2" }) }, // no anchor → gap
      { file: "d", node: junction({ id: "J-h", between: ["L1", "L2"] }) }, // unguarded → gap
      { file: "e", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);
    const conformance = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });

    const m = computeGraphModel(graph, conformance);
    const byId = new Map(m.nodes.map((nd) => [nd.id, nd]));

    expect(byId.get("F-x")?.cls).toBe("structural");
    expect(byId.get("C1")?.cls).toBe("structural");
    expect(byId.get("L1")?.cls).toBe("met");
    expect(byId.get("L2")?.cls).toBe("gap");
    expect(byId.get("J-h")?.cls).toBe("gap");
    // Summary tallies match.
    expect(m.summary).toMatchObject({ met: 1, gap: 2, structural: 2 });
  });

  it("styles dormant loops apart from graded ones", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "N9", dormant: true, owner: null, anchors: ["src/n.ts#N"] }) },
    ]);
    const m = computeGraphModel(graph, computeConformance(graph, {}));
    expect(m.nodes.find((nd) => nd.id === "N9")?.cls).toBe("dormant");
    expect(m.summary.dormant).toBe(1);
  });

  it("emits an edge only when both endpoints are present (dangling refs draw nothing)", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1", "L-GHOST"] }) },
      { file: "b", node: loop({ id: "L1" }) },
    ]);
    const m = computeGraphModel(graph, computeConformance(graph, {}));
    // C1→L1 is drawn; C1→L-GHOST is not (L-GHOST is not a node).
    expect(m.edges).toEqual([{ source: "C1", target: "L1", style: "solid" }]);
  });

  it("carries gap kinds onto the node for the tooltip", () => {
    const { graph } = buildGraph([{ file: "a", node: loop({ id: "L1" }) }]);
    const m = computeGraphModel(graph, computeConformance(graph, {}));
    expect(m.nodes.find((nd) => nd.id === "L1")?.gaps).toEqual(["no-anchor", "no-scenario"]);
  });
});

describe("renderGraphHtml — self-contained, deterministic, safe", () => {
  const meta = { title: "test model", stalenessBanner: "", repoResolved: true };

  function sampleModel() {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1", "L2"] }) },
      { file: "b", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "c", node: loop({ id: "L2" }) },
      { file: "d", node: junction({ id: "J-h", between: ["L1", "L2"] }) },
    ]);
    return computeGraphModel(graph, computeConformance(graph, {}));
  }

  it("references NO external host — no http(s) URLs except the SVG namespace", () => {
    const html = renderGraphHtml(sampleModel(), meta);
    const urls = html.match(/https?:\/\/[^\s"')]+/g) ?? [];
    // The only allowed absolute URL is the SVG namespace used by createElementNS.
    for (const u of urls) expect(u).toBe("http://www.w3.org/2000/svg");
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("cdn");
  });

  it("embeds the node data as inline JSON with node ids and verdict classes", () => {
    const html = renderGraphHtml(sampleModel(), meta);
    const m = html.match(/<script type="application\/json" id="lg-data">(.*?)<\/script>/s);
    const json = m?.[1];
    if (json === undefined) throw new Error("lg-data island not found");
    const data = JSON.parse(json.replace(/\\u003c/g, "<"));
    expect(data.nodes.map((nd: { id: string }) => nd.id).sort()).toEqual(["C1", "J-h", "L1", "L2"]);
    expect(
      data.nodes.every(
        (nd: { x: number; y: number }) => Number.isFinite(nd.x) && Number.isFinite(nd.y),
      ),
    ).toBe(true);
  });

  it("is byte-for-byte deterministic across regeneration (cold==warm)", () => {
    const model = sampleModel();
    expect(renderGraphHtml(model, meta)).toBe(renderGraphHtml(model, meta));
  });

  it("does not let a title containing </script> break out of the data block", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", title: "danger </script><script>alert(1)</script>" }) },
    ]);
    const html = renderGraphHtml(computeGraphModel(graph, computeConformance(graph, {})), meta);
    // The raw closing tag must be escaped inside the JSON island.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("shows the structural-mode warning when not repo-resolved, hides it otherwise", () => {
    const model = sampleModel();
    expect(renderGraphHtml(model, { ...meta, repoResolved: false })).toContain(
      "not resolved against code",
    );
    expect(renderGraphHtml(model, { ...meta, repoResolved: true })).not.toContain(
      "not resolved against code",
    );
  });
});

describe("runGraph / CLI — against the synthetic seed model", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "codeontic-graph-test-"));
    await seedSyntheticModel(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes a self-contained graph.html to the ws side-channel and exits 0", async () => {
    const lines: string[] = [];
    const code = await run(["graph", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("wrote ");
    const path = join(workDir, ".codeontic", "ws", "graph.html");
    const html = await readFile(path, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("codeontic — model conformance graph");
    // Structural run (no --repo-root) is labeled.
    expect(out).toContain("structural");
  });

  it("honors --out and reflects repo-resolved conformance in the summary line", async () => {
    const outPath = join(workDir, "graph-custom.html");
    const lines: string[] = [];
    const code = await run(["graph", workDir, "--repo-root", workDir, "--out", outPath], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(outPath);
    const html = await readFile(outPath, "utf8");
    expect(html).toContain("lg-data");
    // Resolved run does NOT carry the structural note.
    expect(lines.join("\n")).not.toContain("structural");
  });

  it("skips loudly when the model dir is missing, still exits 0", async () => {
    const empty = await mkdtemp(join(tmpdir(), "codeontic-graph-empty-"));
    try {
      const lines: string[] = [];
      const code = await run(["graph", empty], {
        log: (m) => lines.push(m),
        error: (m) => lines.push(m),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("⚠ graph skipped:");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
