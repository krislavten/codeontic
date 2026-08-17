import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadModel } from "../src/loader/load-model.js";
import { runSearch, tokenize } from "../src/query/search.js";
import { runSearchCommand } from "../src/query/search.js";

let targetDir: string;

beforeEach(async () => {
  targetDir = await mkdtemp(join(tmpdir(), "codeontic-search-test-"));
});

afterEach(async () => {
  await rm(targetDir, { recursive: true, force: true });
});

async function writeYaml(subdir: string, filename: string, content: string) {
  const dir = join(targetDir, ".codeontic", "model", subdir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf8");
}

async function buildGraph() {
  const load = await loadModel(join(targetDir, ".codeontic", "model"));
  return load.graph;
}

describe("tokenize", () => {
  it("splits camelCase into separate tokens", () => {
    expect(tokenize("paymentGateway")).toEqual(["payment", "gateway"]);
  });

  it("drops single-char tokens", () => {
    expect(tokenize("a big thing")).toEqual(["big", "thing"]);
  });

  it("lowercases and deduplicates", () => {
    expect(tokenize("Hello HELLO hello")).toEqual(["hello"]);
  });

  it("handles CJK characters", () => {
    const tokens = tokenize("支付网关");
    expect(tokens).toContain("支付网关");
  });

  it("splits on non-alphanumeric characters", () => {
    expect(tokenize("foo-bar_baz")).toEqual(["foo", "bar", "baz"]);
  });
});

describe("runSearch", () => {
  it("returns hits scored by title/id match", async () => {
    await writeYaml(
      "loops",
      "payment.yaml",
      `id: L1
kind: loop
title: Payment processing loop
boundary: stripe-service
owner: payments-team
anchors:
  - src/payments/charge.ts
`,
    );
    await writeYaml(
      "flows",
      "checkout.yaml",
      `id: C1
kind: flow
title: Checkout flow
anchors:
  - src/checkout/index.ts
`,
    );

    const graph = await buildGraph();
    const result = runSearch(graph, "payment");

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.id).toBe("L1");
    expect(result.hits[0]?.score).toBeGreaterThan(0);
  });

  it("ranks title/id match above body match", async () => {
    await writeYaml(
      "loops",
      "alpha.yaml",
      `- id: L1
  kind: loop
  title: Alpha loop
  boundary: alpha-svc
  owner: team-a
  anchors:
    - src/alpha.ts
- id: L2
  kind: loop
  title: Something else
  boundary: beta-svc alpha mentioned
  owner: team-b
  anchors:
    - src/beta.ts
`,
    );

    const graph = await buildGraph();
    const result = runSearch(graph, "alpha");
    const direct = result.hits.filter((h) => !h.related);

    expect(direct.length).toBeGreaterThanOrEqual(1);
    expect(direct[0]?.id).toBe("L1");
  });

  it("returns zero hits for unmatched query", async () => {
    await writeYaml(
      "loops",
      "only.yaml",
      `id: L1
kind: loop
title: Only loop
boundary: only-svc
owner: team
anchors:
  - src/only.ts
`,
    );

    const graph = await buildGraph();
    const result = runSearch(graph, "zzzznonexistent");

    expect(result.hits.length).toBe(0);
  });

  it("is deterministic — same input produces same output", async () => {
    await writeYaml(
      "loops",
      "det.yaml",
      `- id: L1
  kind: loop
  title: Deterministic loop A
  boundary: svc-a
  owner: team
  anchors:
    - src/det-a.ts
- id: L2
  kind: loop
  title: Deterministic loop B
  boundary: svc-b
  owner: team
  anchors:
    - src/det-b.ts
`,
    );

    const graph = await buildGraph();
    const r1 = runSearch(graph, "deterministic");
    const r2 = runSearch(graph, "deterministic");

    expect(r1.hits.map((h) => h.id)).toEqual(r2.hits.map((h) => h.id));
    expect(r1.hits.map((h) => h.score)).toEqual(r2.hits.map((h) => h.score));
  });

  it("stable sort — tied scores produce consistent ordering by id", async () => {
    await writeYaml(
      "loops",
      "tied.yaml",
      `- id: L2
  kind: loop
  title: shared keyword
  boundary: svc
  owner: team
  anchors:
    - src/b.ts
- id: L1
  kind: loop
  title: shared keyword
  boundary: svc
  owner: team
  anchors:
    - src/a.ts
`,
    );

    const graph = await buildGraph();
    const result = runSearch(graph, "shared keyword");
    const direct = result.hits.filter((h) => !h.related);

    expect(direct.length).toBe(2);
    expect(direct[0]?.id).toBe("L1");
    expect(direct[1]?.id).toBe("L2");
  });

  it("includes 1-hop related nodes from impactOf", async () => {
    await writeYaml(
      "loops",
      "hub.yaml",
      `id: L1
kind: loop
title: Hub loop
boundary: hub-svc
owner: team
anchors:
  - src/hub.ts
`,
    );
    await writeYaml(
      "flows",
      "uses-hub.yaml",
      `id: C1
kind: flow
title: Uses hub
anchors:
  - src/flow.ts
traverses:
  - L1
`,
    );

    const graph = await buildGraph();
    const result = runSearch(graph, "hub loop");

    const directIds = result.hits.filter((h) => !h.related).map((h) => h.id);
    const relatedIds = result.hits.filter((h) => h.related).map((h) => h.id);

    expect(directIds).toContain("L1");
    if (!directIds.includes("C1")) {
      expect(relatedIds).toContain("C1");
    }
  });
});

describe("runSearchCommand", () => {
  it("writes side-channel file and returns summary", async () => {
    await writeYaml(
      "loops",
      "cmd.yaml",
      `id: L1
kind: loop
title: Command test loop
boundary: cmd-svc
owner: team
anchors:
  - src/cmd.ts
`,
    );

    const graph = await buildGraph();
    const result = await runSearchCommand(targetDir, "command", graph);

    expect(result.query).toBe("command");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.summary).toContain("command");
    expect(result.outputPath).toContain(".codeontic/ws/search-command.md");
  });

  it("summary shows guidance on zero hits", async () => {
    await writeYaml(
      "loops",
      "empty.yaml",
      `id: L1
kind: loop
title: Empty
boundary: svc
owner: team
anchors:
  - src/e.ts
`,
    );

    const graph = await buildGraph();
    const result = await runSearchCommand(targetDir, "xyznonexistent", graph);

    expect(result.summary).toContain("0 hits");
    expect(result.summary).toContain("inspect/overview");
  });
});
