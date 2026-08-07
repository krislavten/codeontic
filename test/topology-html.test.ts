import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, ImplementationFact } from "../src/adapters/types.js";
import { loadObservedEdges } from "../src/cli/commands/topology.js";
import { run } from "../src/cli/run.js";
import type { Component } from "../src/config/components.js";
import { runFacts } from "../src/facts/runner.js";
import {
  UNATTRIBUTED_NODE_ID,
  computeTopologyEdgeDiff,
  computeTopologyModel,
  renderTopologyHtml,
} from "../src/views/topology-html.js";

// ─── computeTopologyModel — pure ─────────────────────────────────────────

const WEB: Component = { id: "web", role: "frontend", paths: ["apps/web"] };
const API: Component = { id: "api", role: "api", paths: ["apps/api"] };
const PACKAGES: Component = { id: "packages", role: "library", paths: ["packages"] };
const PACKAGES_API: Component = {
  id: "packages-api",
  role: "library",
  paths: ["packages/api"],
};

function fact(overrides: Partial<ImplementationFact> & Pick<ImplementationFact, "filePath">) {
  const base: ImplementationFact = {
    signal: "outbound_edge",
    name: "x",
    filePath: overrides.filePath,
    line: 1,
  };
  return { ...base, ...overrides };
}

describe("computeTopologyModel", () => {
  it("seeds one node per declared component, even with zero facts", () => {
    const m = computeTopologyModel([], [WEB, API], false);
    expect(m.nodes.map((n) => n.id).sort()).toEqual(["api", "web"]);
    expect(m.edges).toEqual([]);
    expect(m.summary).toEqual({ components: 2, external: 0, edges: 0 });
    expect(m.unattributedCount).toBe(0);
  });

  it("a fact with no topology hint draws no edge and adds no node", () => {
    const facts = [fact({ filePath: "apps/web/a.ts" })]; // no `.topology`
    const m = computeTopologyModel(facts, [WEB], true);
    expect(m.edges).toEqual([]);
    expect(m.nodes).toHaveLength(1);
  });

  it("derives `from` via componentOf(fact.filePath) — the adapter never supplies it", () => {
    const facts = [
      fact({
        filePath: "apps/web/a.ts",
        topology: { to: "postgres", toKind: "datastore", via: "drizzle" },
      }),
    ];
    const m = computeTopologyModel(facts, [WEB], true);
    expect(m.edges).toEqual([
      {
        source: "web",
        target: "postgres",
        count: 1,
        evidence: [{ filePath: "apps/web/a.ts", line: 1 }],
      },
    ]);
  });

  it("`to` matching an existing component id draws an INTERNAL edge, not a duplicate external node", () => {
    const facts = [
      fact({
        filePath: "apps/web/a.ts",
        topology: { to: "api", toKind: "service", via: "env:API_URL" },
      }),
    ];
    const m = computeTopologyModel(facts, [WEB, API], true);
    expect(m.nodes.filter((n) => n.id === "api")).toHaveLength(1);
    const apiNode = m.nodes.find((n) => n.id === "api");
    expect(apiNode?.kind).toBe("component"); // stays a component, not turned "external"
    expect(m.summary.external).toBe(0);
  });

  it("`to` NOT matching any component id creates an external node carrying toKind", () => {
    const facts = [
      fact({
        filePath: "apps/web/a.ts",
        topology: { to: "gitlab", toKind: "external", via: "env:GITLAB_URL" },
      }),
    ];
    const m = computeTopologyModel(facts, [WEB], true);
    const ext = m.nodes.find((n) => n.id === "gitlab");
    expect(ext).toEqual({ id: "gitlab", label: "gitlab", kind: "external", toKind: "external" });
    expect(m.summary.external).toBe(1);
  });

  it("an external node with no toKind on the hint has toKind simply absent (not a fabricated default)", () => {
    const facts = [fact({ filePath: "apps/web/a.ts", topology: { to: "mystery-service" } })];
    const m = computeTopologyModel(facts, [WEB], true);
    const ext = m.nodes.find((n) => n.id === "mystery-service");
    expect(ext).toEqual({ id: "mystery-service", label: "mystery-service", kind: "external" });
    expect("toKind" in (ext as object)).toBe(false);
  });

  it("a file matching no declared component is bucketed as unattributed, never dropped", () => {
    const facts = [
      fact({
        filePath: "scripts/one-off.ts",
        topology: { to: "postgres", toKind: "datastore", via: "drizzle" },
      }),
    ];
    const m = computeTopologyModel(facts, [WEB], true);
    expect(m.unattributedCount).toBe(1);
    const bucket = m.nodes.find((n) => n.id === UNATTRIBUTED_NODE_ID);
    expect(bucket?.kind).toBe("unattributed");
    expect(m.edges).toEqual([
      {
        source: UNATTRIBUTED_NODE_ID,
        target: "postgres",
        count: 1,
        evidence: [{ filePath: "scripts/one-off.ts", line: 1 }],
      },
    ]);
  });

  it("the unattributed bucket node is absent when every fact is attributed", () => {
    const facts = [
      fact({ filePath: "apps/web/a.ts", topology: { to: "postgres", toKind: "datastore" } }),
    ];
    const m = computeTopologyModel(facts, [WEB], true);
    expect(m.unattributedCount).toBe(0);
    expect(m.nodes.some((n) => n.id === UNATTRIBUTED_NODE_ID)).toBe(false);
  });

  it("a fact pointing `to` the reserved unattributed-bucket id is treated as an invalid hint, not a real node or edge", () => {
    // A misbehaving adapter emitting `to: "(unattributed)"` must not be able
    // to masquerade as, or corrupt, the real bucket — see the module doc
    // comment on UNATTRIBUTED_NODE_ID's collision guard.
    const facts = [
      fact({ filePath: "apps/web/a.ts", topology: { to: UNATTRIBUTED_NODE_ID } }),
      fact({ filePath: "scripts/x.ts", topology: { to: "postgres" } }), // genuinely unattributed
    ];
    const m = computeTopologyModel(facts, [WEB], true);
    expect(m.unattributedCount).toBe(1); // only the genuine one counts
    const bucket = m.nodes.find((n) => n.id === UNATTRIBUTED_NODE_ID);
    expect(bucket?.kind).toBe("unattributed"); // never hijacked into "external"
    expect(m.edges).toEqual([
      {
        source: UNATTRIBUTED_NODE_ID,
        target: "postgres",
        count: 1,
        evidence: [{ filePath: "scripts/x.ts", line: 1 }],
      },
    ]);
  });

  it("aggregates repeated (from, to) pairs into one edge with a count and capped evidence", () => {
    const facts = Array.from({ length: 8 }, (_, i) =>
      fact({
        filePath: "apps/web/a.ts",
        line: i + 1,
        topology: { to: "postgres", toKind: "datastore", via: "drizzle" },
      }),
    );
    const m = computeTopologyModel(facts, [WEB], true);
    expect(m.edges).toHaveLength(1);
    const e = m.edges[0];
    expect(e?.count).toBe(8);
    expect(e?.evidence).toHaveLength(5); // EVIDENCE_CAP
    expect(e?.evidence.map((ev) => ev.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("nested component declarations resolve via longest-prefix — the same invariant componentOf itself guarantees", () => {
    const facts = [
      fact({
        filePath: "packages/api/client.ts",
        topology: { to: "postgres", toKind: "datastore" },
      }),
      fact({
        filePath: "packages/other/util.ts",
        topology: { to: "redis", toKind: "datastore" },
      }),
    ];
    const m = computeTopologyModel(facts, [PACKAGES, PACKAGES_API], true);
    const bySource = Object.fromEntries(m.edges.map((e) => [e.target, e.source]));
    expect(bySource.postgres).toBe("packages-api"); // longest prefix wins
    expect(bySource.redis).toBe("packages"); // falls back to the broader declaration
  });

  it("node order is deterministic: role groups (frontend,api,worker,sandbox,library), then external, then unattributed, each id-sorted", () => {
    const worker: Component = { id: "zworker", role: "worker", paths: ["apps/worker"] };
    const sandbox: Component = { id: "zsandbox", role: "sandbox", paths: ["apps/sandbox"] };
    const library: Component = { id: "zlib", role: "library", paths: ["packages/lib"] };
    const facts = [
      fact({ filePath: "scripts/x.ts", topology: { to: "gitlab" } }), // unattributed
      fact({ filePath: "apps/web/a.ts", topology: { to: "postgres", toKind: "datastore" } }),
    ];
    const m = computeTopologyModel(facts, [library, sandbox, worker, API, WEB], true);
    expect(m.nodes.map((n) => n.id)).toEqual([
      "web", // frontend
      "api", // api
      "zworker", // worker
      "zsandbox", // sandbox
      "zlib", // library
      "gitlab", // external
      "postgres", // external
      UNATTRIBUTED_NODE_ID, // always last
    ]);
  });

  it("edge order is deterministic: sorted by (source, target)", () => {
    const facts = [
      fact({ filePath: "apps/api/b.ts", topology: { to: "redis" } }),
      fact({ filePath: "apps/web/a.ts", topology: { to: "postgres" } }),
      fact({ filePath: "apps/api/a.ts", topology: { to: "postgres" } }),
    ];
    const m = computeTopologyModel(facts, [WEB, API], true);
    expect(m.edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "api->postgres",
      "api->redis",
      "web->postgres",
    ]);
  });

  it("carries factsRan through unchanged", () => {
    expect(computeTopologyModel([], [WEB], false).factsRan).toBe(false);
    expect(computeTopologyModel([], [WEB], true).factsRan).toBe(true);
  });
});

// ─── renderTopologyHtml — self-contained, deterministic, safe ───────────

describe("renderTopologyHtml", () => {
  function sampleModel() {
    return computeTopologyModel(
      [
        fact({
          filePath: "apps/web/a.ts",
          topology: { to: "postgres", toKind: "datastore", via: "drizzle" },
        }),
      ],
      [WEB],
      true,
    );
  }

  it("references NO external host — no http(s) URLs except the SVG namespace", () => {
    const html = renderTopologyHtml(sampleModel(), { title: "t" });
    const urls = html.match(/https?:\/\/[^\s"')]+/g) ?? [];
    for (const u of urls) expect(u).toBe("http://www.w3.org/2000/svg");
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("cdn");
  });

  it("is byte-for-byte deterministic across regeneration — two SEPARATELY computed models, not the same object reused", () => {
    // Deliberately calls sampleModel() twice rather than rendering one shared
    // `m` twice: that would only prove renderTopologyHtml is a pure function
    // of an already-built model, not that computeTopologyModel + layout
    // together produce the same model from the same input every time.
    expect(renderTopologyHtml(sampleModel(), { title: "t" })).toBe(
      renderTopologyHtml(sampleModel(), { title: "t" }),
    );
  });

  it("does not let a node label containing </script> break out of the JSON island", () => {
    const evil: Component = {
      id: "web",
      label: "danger</script><script>alert(1)</script>",
      role: "frontend",
      paths: ["apps/web"],
    };
    const m = computeTopologyModel([], [evil], false);
    const html = renderTopologyHtml(m, { title: "t" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("shows the no-facts banner only when factsRan is false", () => {
    const withFacts = computeTopologyModel([], [WEB], true);
    const withoutFacts = computeTopologyModel([], [WEB], false);
    expect(renderTopologyHtml(withoutFacts, { title: "t" })).toContain("no facts extracted");
    expect(renderTopologyHtml(withFacts, { title: "t" })).not.toContain("no facts extracted");
  });

  it("shows the adapter's coverageNote verbatim when supplied", () => {
    const html = renderTopologyHtml(sampleModel(), {
      title: "t",
      coverageNote: "17/62 (27%) of fetch call sites are named-env-URL reachable",
    });
    expect(html).toContain("17/62 (27%) of fetch call sites are named-env-URL reachable");
  });

  it("falls back to a generic, still-honest caveat when the adapter supplies none", () => {
    const html = renderTopologyHtml(sampleModel(), { title: "t" });
    expect(html).toContain("未提供具体覆盖率说明");
  });

  it("also falls back when the adapter supplies an empty/whitespace-only note — `??` alone would miss this", () => {
    for (const blank of ["", "   "]) {
      const html = renderTopologyHtml(sampleModel(), { title: "t", coverageNote: blank });
      expect(html).toContain("未提供具体覆盖率说明");
    }
  });

  it("shows the standing edge-density reading guide whenever there is at least one edge, regardless of coverageNote", () => {
    // Present even when the adapter DOES supply its own coverageNote — this
    // guide is a separate, engine-owned guarantee, not a substitute for one.
    const withNote = renderTopologyHtml(sampleModel(), {
      title: "t",
      coverageNote: "some adapter-specific text",
    });
    expect(withNote).toContain("内部组件之间的边通常比指向外部依赖");
    const withoutNote = renderTopologyHtml(sampleModel(), { title: "t" });
    expect(withoutNote).toContain("内部组件之间的边通常比指向外部依赖");
  });

  it("hides the edge-density guide when there are no edges — nothing to (mis)judge the density of", () => {
    const empty = computeTopologyModel([], [WEB], true);
    expect(renderTopologyHtml(empty, { title: "t" })).not.toContain(
      "内部组件之间的边通常比指向外部依赖",
    );
  });

  it("surfaces the unattributed count with an actionable message, only when > 0", () => {
    const withUnattributed = computeTopologyModel(
      [fact({ filePath: "scripts/x.ts", topology: { to: "postgres" } })],
      [WEB],
      true,
    );
    const html = renderTopologyHtml(withUnattributed, { title: "t" });
    expect(html).toContain(
      "1 topology-tagged fact(s) came from a file that matched no declared component",
    );

    const clean = computeTopologyModel([], [WEB], true);
    expect(renderTopologyHtml(clean, { title: "t" })).not.toContain(
      "came from a file that matched no declared component",
    );
  });

  it("embeds nodes with finite deterministic positions", () => {
    const html = renderTopologyHtml(sampleModel(), { title: "t" });
    const m = html.match(/<script type="application\/json" id="tg-data">(.*?)<\/script>/s);
    const json = m?.[1];
    if (json === undefined) throw new Error("tg-data island not found");
    const data = JSON.parse(json.replace(/\\u003c/g, "<"));
    expect(
      data.nodes.every(
        (nd: { x: number; y: number }) => Number.isFinite(nd.x) && Number.isFinite(nd.y),
      ),
    ).toBe(true);
  });
});

// ─── runTopology / CLI ────────────────────────────────────────────────────

const syntheticAdapter: Adapter = {
  interfaceVersion: "v2",
  name: "synthetic",
  version: "synthetic-1",
  candidatePattern: "callDb\\(",
  topologyCoverageNote: "synthetic test adapter, 100% coverage by construction",
  extractFacts(filePath: string, content: string): ImplementationFact[] {
    if (!content.includes("callDb(")) return [];
    return [
      {
        signal: "db_call",
        name: `db@${filePath}`,
        filePath,
        line: 1,
        topology: { to: "postgres", toKind: "datastore", via: "callDb" },
      },
    ];
  },
};

async function writeAdapterFile(dir: string): Promise<string> {
  const adapterFile = join(dir, "my-adapter.mjs");
  await writeFile(
    adapterFile,
    [
      "export default {",
      '  interfaceVersion: "v2",',
      '  name: "synthetic",',
      '  version: "synthetic-1",',
      '  candidatePattern: "callDb\\\\(",',
      '  topologyCoverageNote: "synthetic test adapter, 100% coverage by construction",',
      "  extractFacts(filePath, content) {",
      '    if (!content.includes("callDb(")) return [];',
      '    return [{ signal: "db_call", name: "db@" + filePath, filePath, line: 1,',
      '      topology: { to: "postgres", toKind: "datastore", via: "callDb" } }];',
      "  },",
      "};",
    ].join("\n"),
    "utf8",
  );
  return adapterFile;
}

describe("runTopology / CLI — against a synthetic components + adapter fixture", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "codeontic-topology-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function seedComponents(components: unknown): Promise<void> {
    await mkdir(join(workDir, ".codeontic"), { recursive: true });
    await writeFile(
      join(workDir, ".codeontic", "config.json"),
      JSON.stringify({ components }),
      "utf8",
    );
  }

  it("skips loudly, distinctly, when components is malformed vs. simply absent — different text AND different log severity", async () => {
    // absent entirely — a normal, unconfigured state: routine ⚠ warning via io.log.
    const logsAbsent: string[] = [];
    await run(["topology", workDir], {
      log: (l) => logsAbsent.push(l),
      error: (l) => logsAbsent.push(`ERR:${l}`),
    });
    expect(logsAbsent.some((l) => l.includes("no `components` declared"))).toBe(true);
    expect(logsAbsent.some((l) => l.startsWith("ERR:"))).toBe(false);

    // malformed (role not in the closed set) — a real problem: io.error with
    // a "✗" prefix, the same severity `check` gives its own inv1ConfigError.
    await seedComponents([{ id: "web", role: "not-a-real-role", paths: ["apps/web"] }]);
    const logsMalformed: string[] = [];
    const code = await run(["topology", workDir], {
      log: (l) => logsMalformed.push(l),
      error: (l) => logsMalformed.push(`ERR:${l}`),
    });
    expect(code).toBe(0); // advisory: never a hard failure
    expect(
      logsMalformed.some((l) => l.includes("ERR:") && l.includes("failed schema validation")),
    ).toBe(true);
    // The two skip reasons must not read the same way (team-lead's explicit requirement).
    expect(logsMalformed.some((l) => l.includes("no `components` declared"))).toBe(false);
  });

  it("renders declared components with zero edges when --repo-root is omitted (degrade, not skip)", async () => {
    await seedComponents([{ id: "web", role: "frontend", paths: ["apps/web"] }]);
    const logs: string[] = [];
    const code = await run(["topology", workDir], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(`ERR:${l}`),
    });
    expect(code).toBe(0);
    expect(
      logs.some((l) => l.includes("1 component(s), 0 external") && l.includes("0 edge(s)")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("no facts"))).toBe(true);
  });

  it("writes a self-contained topology.html with real edges when --repo-root + adapter are given", async () => {
    await seedComponents([{ id: "web", role: "frontend", paths: ["apps/web"] }]);
    const adapterFile = await writeAdapterFile(workDir);
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workDir });
    await mkdir(join(workDir, "apps", "web"), { recursive: true });
    await writeFile(join(workDir, "apps", "web", "a.ts"), "callDb();\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });

    const logs: string[] = [];
    const code = await run(
      ["topology", workDir, "--repo-root", workDir, "--adapter-path", adapterFile, "--no-cache"],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(
      logs.some((l) => l.includes("1 component(s), 1 external") && l.includes("1 edge(s)")),
    ).toBe(true);
    const written = logs.find((l) => l.startsWith("wrote "));
    if (!written) throw new Error("no 'wrote <path>' line");
    const outPath = written.slice("wrote ".length);
    const html = await (await import("node:fs/promises")).readFile(outPath, "utf8");
    expect(html).toContain("postgres");
    expect(html).toContain("synthetic test adapter, 100% coverage by construction");
    const urls = html.match(/https?:\/\/[^\s"')]+/g) ?? [];
    expect(urls.every((u) => u === "http://www.w3.org/2000/svg")).toBe(true);
  });
});

// ─── the fact-cache round-trip — the specific risk this PR was warned about ──

describe("topology field survives the content-addressed fact cache round-trip", () => {
  let repo: string;
  let cacheDir: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-topology-cache-repo-"));
    cacheDir = await mkdtemp(join(tmpdir(), "codeontic-topology-cache-dir-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "w.ts"), "callDb();\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("a COLD run and a WARM (served-from-cache) run both carry the full topology hint", async () => {
    // Wraps extractFacts in a spy so "warm" isn't just asserted by name — the
    // test PROVES the second run never re-extracted by checking the call
    // count stayed at 1, which is the only way to rule out both runs quietly
    // taking the cold path (cacheDir misconfigured, cache write failing
    // silently, …) and the assertions below passing for the wrong reason.
    const extractFacts = vi.fn(syntheticAdapter.extractFacts);
    const spiedAdapter = { ...syntheticAdapter, extractFacts };

    // Cold: nothing cached yet.
    const cold = await runFacts(repo, { adapter: spiedAdapter, cacheDir });
    expect(cold.ran).toBe(true);
    expect(cold.facts).toHaveLength(1);
    expect(cold.facts[0]?.topology).toEqual({ to: "postgres", toKind: "datastore", via: "callDb" });
    expect(extractFacts).toHaveBeenCalledTimes(1);

    // Warm: same repo, same cacheDir, file bytes unchanged — must be served
    // from the on-disk JSON cache entry written by the cold run above. If the
    // cache's generic JSON.stringify/parse ever grew a field allowlist, this
    // is exactly the assertion that would catch a `topology` field silently
    // stripped on the warm path while looking identical on the cold one.
    const warm = await runFacts(repo, { adapter: spiedAdapter, cacheDir });
    expect(warm.ran).toBe(true);
    expect(warm.facts).toEqual(cold.facts);
    expect(warm.facts[0]?.topology).toEqual({ to: "postgres", toKind: "datastore", via: "callDb" });
    // Unchanged since the cold run: extractFacts was NOT called again — this
    // is what actually proves the warm run was served from cache.
    expect(extractFacts).toHaveBeenCalledTimes(1);
  });
});

// ─── computeTopologyEdgeDiff — pure (issue #23 §4 / 阶段3 PR8) ────────────

describe("computeTopologyEdgeDiff", () => {
  const PATH_BY_COMPONENT: Record<string, string> = {
    web: "apps/web/a.ts",
    api: "apps/api/a.ts",
  };

  /** Builds a real TopologyModel whose static edges are exactly the given (from, to) pairs, via `computeTopologyModel` itself (not hand-assembled) — so these tests exercise the real edge shape, not a stand-in. */
  function modelWith(edges: { from: string; to: string }[], components: Component[] = [WEB, API]) {
    const facts = edges.map((e, i) =>
      fact({
        filePath: PATH_BY_COMPONENT[e.from] ?? "apps/web/a.ts",
        line: i + 1,
        topology: { to: e.to },
      }),
    );
    return computeTopologyModel(facts, components, true);
  }

  it("both sides present, non-queue → confirmed, origin=both (denominator=1 here is below the small-sample threshold — see the dedicated MIN_COVERAGE_SAMPLE tests for the formula itself at a size where it actually shows a percentage)", () => {
    const model = modelWith([{ from: "web", to: "postgres" }]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "postgres" }]);
    expect(diff.edges).toEqual([
      {
        source: "web",
        target: "postgres",
        category: "confirmed",
        origin: "both",
        staticCount: 1,
        evidence: [{ filePath: "apps/web/a.ts", line: 1 }],
        observedCount: 1,
      },
    ]);
    expect(diff.summary).toEqual({
      confirmed: 1,
      staticOnly: 0,
      observedOnly: 0,
      unobservable: 0,
      queueMediated: 0,
      observedTotal: 1,
      // denominator = 1 < MIN_COVERAGE_SAMPLE — a 1/1=100% here would be
      // exactly as misleading as the confirmed/observedTotal formula this
      // pivot replaced (see staticCoverage's own doc for the incident).
      staticCoverage: null,
      staticCoverageDenominator: 1,
      staticCoverageNaReason: expect.stringContaining("样本过小"),
      observableScopeDeclared: false,
      targetKindsScopeDeclared: false,
      targetKindsUncheckable: 0,
    });
  });

  it("static edge with no matching observed row, NO observableComponents declared → unobservable (the conservative default), not static-only, and the n/a reason names the undeclared scope", () => {
    const model = modelWith([{ from: "web", to: "postgres" }]);
    const diff = computeTopologyEdgeDiff(model, []); // no 3rd argument — scope not declared
    expect(diff.edges).toEqual([
      {
        source: "web",
        target: "postgres",
        category: "unobservable",
        origin: "static",
        staticCount: 1,
        evidence: [{ filePath: "apps/web/a.ts", line: 1 }],
        // "postgres" here has no `toKind` (modelWith's fixture never sets
        // one), so the TARGET-kind axis passes unconditionally (see
        // `targetKindObservable`'s doc) — only the SOURCE axis fails.
        unobservableReason: "source",
      },
    ]);
    // denominator (confirmed+staticOnly) is 0 — every static edge landed in
    // unobservable because scope was never declared, NOT because there was
    // no observed data (there wasn't, but that's not why staticCoverage is
    // null under the new formula — see staticCoverageNaReason).
    expect(diff.summary).toEqual({
      confirmed: 0,
      staticOnly: 0,
      observedOnly: 0,
      unobservable: 1,
      queueMediated: 0,
      observedTotal: 0,
      staticCoverage: null,
      staticCoverageDenominator: 0,
      staticCoverageNaReason: expect.stringContaining("observableComponents"),
      observableScopeDeclared: false,
      targetKindsScopeDeclared: false,
      targetKindsUncheckable: 0,
    });
  });

  it("static edge with no matching observed row, source IS in the declared observable scope → static-only (the real signal); denominator=1 is below the small-sample threshold so no percentage is shown", () => {
    const model = modelWith([{ from: "web", to: "postgres" }]);
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    expect(diff.edges).toEqual([
      {
        source: "web",
        target: "postgres",
        category: "static-only",
        origin: "static",
        staticCount: 1,
        evidence: [{ filePath: "apps/web/a.ts", line: 1 }],
      },
    ]);
    expect(diff.summary).toEqual({
      confirmed: 0,
      staticOnly: 1,
      observedOnly: 0,
      unobservable: 0,
      queueMediated: 0,
      observedTotal: 0,
      // denominator = 1 < MIN_COVERAGE_SAMPLE — even though it's a real,
      // nonzero comparable count, a "0/1 = 0%" reading here would look just
      // as authoritative as a real sample and isn't.
      staticCoverage: null,
      staticCoverageDenominator: 1,
      staticCoverageNaReason: expect.stringContaining("样本过小"),
      observableScopeDeclared: true,
      // observableTargetKinds was NOT passed to this call — the edge still
      // reaches static-only because "postgres" here has no `toKind` at all
      // (see `targetKindObservable`'s doc: an untagged target isn't gated
      // by this axis), but the flag itself still honestly reports "nobody
      // declared it".
      targetKindsScopeDeclared: false,
      targetKindsUncheckable: 0,
    });
  });

  it("static edge with no matching observed row, scope declared but source NOT in it → unobservable, not static-only", () => {
    const model = modelWith([{ from: "web", to: "postgres" }]);
    // Declares a scope, but "web" (the edge's own source) isn't in it.
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["api"] });
    expect(diff.edges[0]?.category).toBe("unobservable");
    expect(diff.summary.staticOnly).toBe(0);
    expect(diff.summary.unobservable).toBe(1);
    expect(diff.summary.observableScopeDeclared).toBe(true);
  });

  it("an EXPLICIT empty observableComponents array classifies the same as an undeclared scope, but observableScopeDeclared records that it WAS declared", () => {
    const model = modelWith([{ from: "web", to: "postgres" }]);
    const declaredEmpty = computeTopologyEdgeDiff(model, [], { observableComponents: [] });
    const undeclared = computeTopologyEdgeDiff(model, []);
    expect(declaredEmpty.edges[0]?.category).toBe("unobservable");
    expect(undeclared.edges[0]?.category).toBe("unobservable");
    expect(declaredEmpty.summary.observableScopeDeclared).toBe(true);
    expect(undeclared.summary.observableScopeDeclared).toBe(false);
  });

  it("observed row with no matching static edge, not queue → observed-only, origin=observed, and creates an honest extra node for an unseen id", () => {
    const model = modelWith([]); // no static edges at all
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "redis" }]);
    expect(diff.edges).toEqual([
      {
        source: "web",
        target: "redis",
        category: "observed-only",
        origin: "observed",
        observedCount: 1,
        // "web" is a declared component, "redis" is not yet known at all —
        // so NOT both-known: this is the "brand-new dependency" case.
        observedOnlyKnownEndpoints: false,
      },
    ]);
    // No static edges at all → staticCoverage is null for the FIRST reason
    // (nothing to compare), not because observed data is empty.
    expect(diff.summary).toEqual({
      confirmed: 0,
      staticOnly: 0,
      observedOnly: 1,
      unobservable: 0,
      queueMediated: 0,
      observedTotal: 1,
      staticCoverage: null,
      staticCoverageDenominator: 0,
      staticCoverageNaReason: expect.stringContaining("静态提取没有产出任何边"),
      observableScopeDeclared: false,
      targetKindsScopeDeclared: false,
      targetKindsUncheckable: 0,
    });
    // "web" is already a declared component (no extra node); "redis" is not
    // — degrades to an honestly-labeled external node, not dropped/crashed.
    const extra = diff.nodes.find((n) => n.id === "redis");
    expect(extra).toEqual({ id: "redis", label: "redis", kind: "external", observedOnly: true });
    expect(diff.nodes.some((n) => n.id === "web")).toBe(true);
  });

  it("observed-only with BOTH endpoints already known (declared component or a static-named id) → observedOnlyKnownEndpoints true", () => {
    // "postgres" is already known (static names it as an edge target below),
    // so an observed "api -> postgres" pair (never extracted statically) has
    // two already-known endpoints — a real extractor gap, not a new dependency.
    const model = modelWith([{ from: "web", to: "postgres" }], [WEB, API]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "api", to: "postgres" }]);
    const edge = diff.edges.find((e) => e.source === "api" && e.target === "postgres");
    expect(edge?.category).toBe("observed-only");
    expect(edge?.observedOnlyKnownEndpoints).toBe(true);
  });

  it("mixed bucket + duplicate observed rows collapse into one distinct pair for the coverage denominator", () => {
    const model = modelWith([
      { from: "web", to: "postgres" },
      { from: "web", to: "redis" },
    ]);
    const diff = computeTopologyEdgeDiff(
      model,
      [
        { from: "web", to: "postgres" },
        { from: "web", to: "postgres" }, // duplicate row — must not double-count observedTotal
        { from: "api", to: "kafka" }, // never extracted statically
      ],
      { observableComponents: ["web"] }, // "web" is the static-only edge's source
    );
    const bySource = Object.fromEntries(diff.edges.map((e) => [`${e.source}->${e.target}`, e]));
    expect(bySource["web->postgres"]?.category).toBe("confirmed");
    expect(bySource["web->postgres"]?.observedCount).toBe(2); // both rows counted as occurrences
    expect(bySource["web->redis"]?.category).toBe("static-only"); // source "web" is in scope
    expect(bySource["api->kafka"]?.category).toBe("observed-only");
    expect(diff.summary).toEqual({
      confirmed: 1,
      staticOnly: 1,
      observedOnly: 1,
      unobservable: 0,
      queueMediated: 0,
      observedTotal: 2, // {web->postgres, api->kafka} — the duplicate row didn't add a 3rd
      // denominator = 1 confirmed + 1 static-only = 2 < MIN_COVERAGE_SAMPLE
      // — the formula (confirmed/(confirmed+staticOnly), untouched by
      // observedTotal) is still exercised via staticCoverageDenominator,
      // just not surfaced as a bare percentage at this sample size.
      staticCoverage: null,
      staticCoverageDenominator: 2,
      staticCoverageNaReason: expect.stringContaining("样本过小"),
      observableScopeDeclared: true,
      // Same reasoning as the previous test — observableTargetKinds was
      // never passed here either; "redis"/"kafka" reach static-only/
      // observed-only anyway because `modelWith` never tags a `toKind`.
      targetKindsScopeDeclared: false,
      targetKindsUncheckable: 0,
    });
    expect(diff.nodes.some((n) => n.id === "kafka")).toBe(true);
    // "api" is a declared component — must NOT also appear as an extra node.
    expect(diff.nodes.filter((n) => n.id === "api")).toHaveLength(1);
  });

  it("a component OUTSIDE the declared scope produces unobservable, not static-only, even when a DIFFERENT component in the same model IS in scope", () => {
    const model = modelWith([
      { from: "web", to: "postgres" }, // web IS in scope below
      { from: "api", to: "redis" }, // api is NOT
    ]);
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    const bySource = Object.fromEntries(diff.edges.map((e) => [`${e.source}->${e.target}`, e]));
    expect(bySource["web->postgres"]?.category).toBe("static-only");
    expect(bySource["api->redis"]?.category).toBe("unobservable");
    expect(diff.summary).toMatchObject({ staticOnly: 1, unobservable: 1 });
  });

  it("an unknown id used as BOTH endpoints of an observed edge creates exactly one node each, never duplicated across edges", () => {
    const model = modelWith([]);
    const diff = computeTopologyEdgeDiff(model, [
      { from: "cache", to: "cache-replica" },
      { from: "cache", to: "web" }, // "cache" referenced again — must not create a second node
    ]);
    expect(diff.nodes.filter((n) => n.id === "cache")).toHaveLength(1);
    expect(diff.nodes.filter((n) => n.id === "cache-replica")).toHaveLength(1);
    const cacheNode = diff.nodes.find((n) => n.id === "cache");
    expect(cacheNode?.kind).toBe("external");
    expect((cacheNode as { observedOnly?: boolean }).observedOnly).toBe(true);
  });

  it("edges are sorted deterministically by (source, target)", () => {
    const model = modelWith([]);
    const diff = computeTopologyEdgeDiff(model, [
      { from: "web", to: "redis" },
      { from: "api", to: "postgres" },
      { from: "api", to: "redis" },
    ]);
    expect(diff.edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "api->postgres",
      "api->redis",
      "web->redis",
    ]);
  });

  // ─── queue-mediated (issue #23 §4 修正1: no producer/consumer pairing) ───

  it("viaQueue on the observed row → queue-mediated, excluded from confirmed/static-only/observed-only entirely, and never enters staticCoverage's denominator", () => {
    const model = modelWith([]); // no static edges at all
    const diff = computeTopologyEdgeDiff(model, [
      { from: "web", to: "some-consumer", viaQueue: true },
    ]);
    expect(diff.edges).toEqual([
      {
        source: "web",
        target: "some-consumer",
        category: "queue-mediated",
        origin: "observed",
        observedCount: 1,
        queueStaticEvidence: false, // no static edge from either endpoint toward a queue-kind node
      },
    ]);
    expect(diff.summary).toMatchObject({
      confirmed: 0,
      staticOnly: 0,
      observedOnly: 0,
      unobservable: 0,
      queueMediated: 1,
      staticCoverageDenominator: 0,
    });
  });

  it("kind === 'consumer' is an alternate queue-mediated signal to viaQueue", () => {
    const model = modelWith([]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "worker", kind: "consumer" }]);
    expect(diff.edges[0]?.category).toBe("queue-mediated");
  });

  it("queueStaticEvidence is false when the endpoints DO have static edges, just not toward a toKind=queue node — distinct from having no static edges at all", () => {
    // Both "web" and "api" have a real static edge each — but to "postgres",
    // not a queue. queueStaticEvidence must stay false here (not because
    // there are no static edges to check, but because neither of the ones
    // that DO exist point at a queue-kind node).
    const model = modelWith([
      { from: "web", to: "postgres" },
      { from: "api", to: "postgres" },
    ]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "api", viaQueue: true }]);
    const queueEdge = diff.edges.find((e) => e.source === "web" && e.target === "api");
    expect(queueEdge?.category).toBe("queue-mediated"); // still queue-mediated regardless
    expect(queueEdge?.queueStaticEvidence).toBe(false);
  });

  it("a viaQueue observed row wins over an incidental static pair-key match — queue-mediated, not confirmed", () => {
    // "api" is a declared component, so a static web->api edge and an
    // observed web->api pair share the exact same (source, target) key —
    // but the observed row's own evidence says it arrived via a queue, and
    // that must not be silently reported as a direct-call "confirmed".
    const model = modelWith([{ from: "web", to: "api" }]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "api", viaQueue: true }]);
    expect(diff.edges).toHaveLength(1);
    expect(diff.edges[0]?.category).toBe("queue-mediated");
    expect(diff.edges[0]?.category).not.toBe("confirmed");
  });

  it("ANY row for a pair carrying viaQueue makes the WHOLE pair queue-mediated, even if other rows for the same pair don't", () => {
    const model = modelWith([]);
    const diff = computeTopologyEdgeDiff(model, [
      { from: "web", to: "worker" },
      { from: "web", to: "worker", viaQueue: true },
    ]);
    expect(diff.edges).toHaveLength(1);
    expect(diff.edges[0]?.category).toBe("queue-mediated");
    expect(diff.edges[0]?.observedCount).toBe(2); // both rows still counted as occurrences
  });

  it("queueStaticEvidence is true only when BOTH endpoints have their own static edge toward a toKind=queue node, and never drives classification", () => {
    const facts = [
      fact({ filePath: "apps/web/a.ts", topology: { to: "broker", toKind: "queue" } }),
      fact({ filePath: "apps/api/a.ts", topology: { to: "broker", toKind: "queue" } }),
    ];
    const model = computeTopologyModel(facts, [WEB, API], true);
    const diff = computeTopologyEdgeDiff(model, [
      { from: "web", to: "api", viaQueue: true }, // still queue-mediated even though both sides independently touch "broker"
    ]);
    // Two OTHER static edges (web->broker, api->broker) are also in the diff
    // — pick out the observed web->api pair specifically rather than
    // assuming array order.
    const queueEdge = diff.edges.find((e) => e.source === "web" && e.target === "api");
    expect(queueEdge?.category).toBe("queue-mediated"); // classification unaffected either way
    expect(queueEdge?.queueStaticEvidence).toBe(true);
  });

  // ─── observableTargetKinds (target-side observability axis) ─────────────
  //
  // Real incident: a target repo's `postgres`/`redis` edges (toKind:
  // "datastore") from a perfectly-observable source were STILL landing in
  // `static-only` ("maybe dead") because no HTTP-span-based observed-edges
  // methodology can ever see a direct DB connection — the same "signal
  // lying about its own cause" failure the source-side `observableComponents`
  // axis was built to catch, just on the other endpoint.

  function modelWithToKind(edges: { from: string; to: string; toKind: string }[]) {
    const facts = edges.map((e, i) =>
      fact({
        filePath: PATH_BY_COMPONENT[e.from] ?? "apps/web/a.ts",
        line: i + 1,
        topology: { to: e.to, toKind: e.toKind },
      }),
    );
    return computeTopologyModel(facts, [WEB, API], true);
  }

  it("source in scope, target-kind NOT in scope → unobservable with reason 'target-kind', not static-only", () => {
    const model = modelWithToKind([{ from: "web", to: "postgres", toKind: "datastore" }]);
    const diff = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["web"],
      observableTargetKinds: ["objectstore"], // declared, but doesn't include "datastore"
    });
    expect(diff.edges[0]?.category).toBe("unobservable");
    expect(diff.edges[0]?.unobservableReason).toBe("target-kind");
    expect(diff.summary).toMatchObject({
      staticOnly: 0,
      unobservable: 1,
      observableScopeDeclared: true,
      targetKindsScopeDeclared: true,
    });
  });

  it("source in scope AND target-kind in scope → static-only (both axes must pass)", () => {
    const model = modelWithToKind([{ from: "web", to: "oss", toKind: "objectstore" }]);
    const diff = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["web"],
      observableTargetKinds: ["objectstore"],
    });
    expect(diff.edges[0]?.category).toBe("static-only");
    expect(diff.edges[0]?.unobservableReason).toBeUndefined();
  });

  it("observableTargetKinds never declared, even though observableComponents WAS → unobservable with reason 'target-kind' (conservative default applies per-axis)", () => {
    const model = modelWithToKind([{ from: "web", to: "postgres", toKind: "datastore" }]);
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    expect(diff.edges[0]?.category).toBe("unobservable");
    expect(diff.edges[0]?.unobservableReason).toBe("target-kind");
    expect(diff.summary.targetKindsScopeDeclared).toBe(false);
  });

  it("BOTH axes fail → unobservableReason is 'both', not just one", () => {
    const model = modelWithToKind([{ from: "web", to: "postgres", toKind: "datastore" }]);
    const diff = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["api"], // "web" (the edge's source) is NOT in it
      observableTargetKinds: ["objectstore"], // "datastore" is NOT in it either
    });
    expect(diff.edges[0]?.category).toBe("unobservable");
    expect(diff.edges[0]?.unobservableReason).toBe("both");
  });

  it("a target with NO toKind at all is never gated by observableTargetKinds — falls through to the source-side check alone", () => {
    // "postgres" here has no toKind (modelWith's plain fixture, unlike
    // modelWithToKind above) — the adapter gave no evidence to distrust, so
    // this axis must not silently exclude it just because the caller never
    // declared observableTargetKinds.
    const model = modelWith([{ from: "web", to: "postgres" }]);
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    expect(diff.edges[0]?.category).toBe("static-only");
  });

  it("a target that IS a declared component is never gated by observableTargetKinds either — only external targets are", () => {
    const model = modelWith([{ from: "web", to: "api" }]); // "api" is a declared component
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    expect(diff.edges[0]?.category).toBe("static-only");
  });

  it("the n/a reason distinguishes 'neither axis declared' from 'only one axis declared' from 'both declared but empty'", () => {
    const model = modelWithToKind([{ from: "web", to: "postgres", toKind: "datastore" }]);

    const neither = computeTopologyEdgeDiff(model, []);
    expect(neither.summary.staticCoverageNaReason).toContain("既没有声明");

    const onlySource = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    expect(onlySource.summary.staticCoverageNaReason).toContain("observableTargetKinds");
    expect(onlySource.summary.staticCoverageNaReason).not.toContain("既没有声明");

    const onlyTargetKinds = computeTopologyEdgeDiff(model, [], {
      observableTargetKinds: ["datastore"],
    });
    expect(onlyTargetKinds.summary.staticCoverageNaReason).toContain("observableComponents");

    const bothDeclaredButEmpty = computeTopologyEdgeDiff(model, [], {
      observableComponents: [],
      observableTargetKinds: [],
    });
    expect(bothDeclaredButEmpty.summary.staticCoverageNaReason).toContain("已声明的可观测范围");
  });

  // ─── MIN_COVERAGE_SAMPLE (don't print a percentage from a tiny sample) ───
  //
  // Real incident: `observableTargetKinds` correctly shrinking the
  // denominator to just the confirmed edges produced a literal "100%
  // covered" reading from a single data point — as misleading, in the
  // opposite direction, as the un-shrunk 5% it replaced. Below the
  // threshold, staticCoverage stays null (with a reason) even though the
  // denominator is real and nonzero.

  /** Builds `n` distinct static edges from "web" to n distinct external targets, all observed (so every one is `confirmed`), plus optionally `staticOnlyCount` more that are static-only. */
  function modelWithManyEdges(confirmedCount: number, staticOnlyCount = 0) {
    const pairs: { from: string; to: string }[] = [];
    for (let i = 0; i < confirmedCount; i++) pairs.push({ from: "web", to: `svc-confirmed-${i}` });
    for (let i = 0; i < staticOnlyCount; i++)
      pairs.push({ from: "web", to: `svc-static-only-${i}` });
    const model = modelWith(pairs);
    const observed = pairs.slice(0, confirmedCount).map((p) => ({ from: p.from, to: p.to }));
    return { model, observed };
  }

  it("denominator below MIN_COVERAGE_SAMPLE → staticCoverage null with a 'sample too small' reason, even though it's genuinely nonzero", () => {
    const { model, observed } = modelWithManyEdges(4); // denominator = 4
    const diff = computeTopologyEdgeDiff(model, observed);
    expect(diff.summary.staticCoverageDenominator).toBe(4);
    expect(diff.summary.staticCoverage).toBeNull();
    expect(diff.summary.staticCoverageNaReason).toContain("样本过小");
  });

  it("denominator AT MIN_COVERAGE_SAMPLE (the boundary itself) → a real percentage IS shown", () => {
    const { model, observed } = modelWithManyEdges(5); // denominator = 5, exactly at the threshold
    const diff = computeTopologyEdgeDiff(model, observed);
    expect(diff.summary.staticCoverageDenominator).toBe(5);
    expect(diff.summary.staticCoverage).toBe(1);
    expect(diff.summary.staticCoverageNaReason).toBeUndefined();
  });

  it("denominator above the threshold, partial coverage → a real, non-100% percentage", () => {
    const { model, observed } = modelWithManyEdges(1, 4); // 1 confirmed + 4 static-only = denominator 5
    const diff = computeTopologyEdgeDiff(model, observed, { observableComponents: ["web"] });
    expect(diff.summary.staticCoverageDenominator).toBe(5);
    expect(diff.summary.staticCoverage).toBe(0.2);
  });

  // ─── targetKindsUncheckable (declared scope that silently doesn't reach every edge) ───

  it("targetKindsUncheckable counts edges whose target has no toKind, ONLY when observableTargetKinds was actually declared", () => {
    const facts = [
      fact({ filePath: "apps/web/a.ts", topology: { to: "postgres", toKind: "datastore" } }),
      fact({ filePath: "apps/web/b.ts", topology: { to: "untagged-thing" } }), // no toKind at all
    ];
    const model = computeTopologyModel(facts, [WEB], true);

    const declared = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["web"],
      observableTargetKinds: ["datastore"],
    });
    // "postgres" (tagged, in scope) → static-only; "untagged-thing" (no
    // toKind) → the axis doesn't apply to it, so it ALSO reaches
    // static-only via the source check alone — but it's counted as
    // "uncheckable" so the caller knows their declared scope didn't
    // actually govern this one.
    expect(declared.summary.targetKindsUncheckable).toBe(1);

    const undeclared = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    // Scope never declared at all → the existing `!targetKindsScopeDeclared`
    // signal already covers this; the uncheckable count must stay 0 (it's
    // specifically for "declared but didn't reach every edge", not "never
    // declared").
    expect(undeclared.summary.targetKindsUncheckable).toBe(0);
  });

  it("targetKindsUncheckable does NOT count an untagged-target edge whose SOURCE is also out of scope — that edge is unobservable regardless, so the declared observableTargetKinds never had a chance to matter for it", () => {
    const facts = [
      fact({ filePath: "apps/web/a.ts", topology: { to: "untagged-thing" } }), // no toKind
    ];
    const model = computeTopologyModel(facts, [WEB, API], true);
    const diff = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["api"], // "web" (the edge's actual source) is NOT in it
      observableTargetKinds: ["datastore"],
    });
    expect(diff.edges[0]?.category).toBe("unobservable"); // source axis alone already fails it
    // An untagged target passes the target-kind axis unconditionally (see
    // targetKindObservable's doc), so ONLY the source axis fails here —
    // reason is "source", not "both".
    expect(diff.edges[0]?.unobservableReason).toBe("source");
    expect(diff.summary.targetKindsUncheckable).toBe(0);
  });

  it("the target-kinds-uncheckable banner and CLI line only fire when the scope IS declared and the count is nonzero", () => {
    const facts = [
      fact({ filePath: "apps/web/a.ts", topology: { to: "untagged-thing" } }), // no toKind
    ];
    const model = computeTopologyModel(facts, [WEB], true);
    const diff = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["web"],
      observableTargetKinds: ["datastore"],
    });
    expect(diff.summary.targetKindsUncheckable).toBe(1);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).toContain("1 条边的目标没有 toKind 标注");

    // Same underlying data, but scope never declared — the uncheckable
    // banner must NOT appear (the generic "not declared at all" banner
    // covers this case instead).
    const undeclaredDiff = computeTopologyEdgeDiff(model, []);
    const undeclaredHtml = renderTopologyHtml(
      model,
      { title: "t" },
      { status: "ok", diff: undeclaredDiff },
    );
    expect(undeclaredHtml).not.toContain("条边的目标没有 toKind 标注");
  });

  // ─── self-loop exclusion (defense-in-depth against artifacts) ───────────

  it("excludes a self-referencing STATIC edge (source === target) from every bucket, and counts it", () => {
    const model = modelWith([{ from: "web", to: "web" }]);
    const diff = computeTopologyEdgeDiff(model, []);
    expect(diff.edges).toHaveLength(0);
    expect(diff.selfLoopEdgesExcluded).toBe(1);
  });

  it("excludes a self-referencing OBSERVED edge (from === to) from every bucket, and counts it", () => {
    const model = modelWith([]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "web" }]);
    expect(diff.edges).toHaveLength(0);
    expect(diff.selfLoopEdgesExcluded).toBe(1);
    // Must not even create a phantom node for it.
    expect(diff.nodes.filter((n) => n.id === "web")).toHaveLength(1);
  });

  it("counts self-loops from BOTH sides together, and leaves every non-self-loop edge unaffected", () => {
    const model = modelWith([
      { from: "web", to: "web" },
      { from: "web", to: "postgres" },
    ]);
    const diff = computeTopologyEdgeDiff(model, [
      { from: "api", to: "api" },
      { from: "web", to: "postgres" },
    ]);
    expect(diff.selfLoopEdgesExcluded).toBe(2);
    expect(diff.edges).toHaveLength(1);
    expect(diff.edges[0]).toMatchObject({
      source: "web",
      target: "postgres",
      category: "confirmed",
    });
  });

  // ─── nameSimilarityHints (suggestion only, never auto-merged) ───────────

  it("flags a containment match between an observed-only target and a static-only target, either direction", () => {
    const model = modelWith([{ from: "web", to: "corp-sandbox" }]);
    const diff = computeTopologyEdgeDiff(
      model,
      [{ from: "web", to: "sandbox" }],
      { observableComponents: ["web"] }, // makes web->corp-sandbox eligible for static-only
    );
    expect(diff.nameSimilarityHints).toEqual([{ observedId: "sandbox", staticId: "corp-sandbox" }]);
    // Never auto-merged: both ids still exist as SEPARATE nodes/edges.
    expect(diff.nodes.filter((n) => n.id === "sandbox")).toHaveLength(1);
    expect(diff.nodes.filter((n) => n.id === "corp-sandbox")).toHaveLength(1);
  });

  it("does NOT flag dissimilar names, even when both are un-matched external targets", () => {
    const model = modelWith([{ from: "web", to: "postgres" }]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "redis" }], {
      observableComponents: ["web"],
    });
    expect(diff.nameSimilarityHints).toEqual([]);
  });

  it("does NOT flag two ids that are already an EXACT match (that pair is confirmed, not a mismatch to hint about)", () => {
    const model = modelWith([{ from: "web", to: "oss" }]);
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "oss" }]);
    expect(diff.nameSimilarityHints).toEqual([]);
  });

  it("does NOT compare within the same bucket — two observed-only ids are never hinted against each other, only against static-only", () => {
    const model = modelWith([]);
    const diff = computeTopologyEdgeDiff(model, [
      { from: "web", to: "cache" },
      { from: "web", to: "cache-replica" }, // contains "cache" — but both are observed-only, not a cross-bucket pair
    ]);
    expect(diff.nameSimilarityHints).toEqual([]);
  });

  it("ignores very short ids (below the noise-guard minimum length) even if one contains the other", () => {
    const model = modelWith([{ from: "web", to: "os" }]); // 2 chars
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "oss" }], {
      observableComponents: ["web"],
    });
    expect(diff.nameSimilarityHints).toEqual([]);
  });
});

// ─── loadObservedEdges — I/O (the --compare-edges file loader) ───────────

describe("loadObservedEdges", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codeontic-observed-edges-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a valid file with no observableComponents", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify({ edges: [{ from: "web", to: "api" }] }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result).toEqual({ ok: true, edges: [{ from: "web", to: "api" }] });
  });

  it("loads a valid file WITH observableComponents", async () => {
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({
        observableComponents: ["web", "api"],
        edges: [{ from: "web", to: "api" }],
      }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result).toEqual({
      ok: true,
      edges: [{ from: "web", to: "api" }],
      observableComponents: ["web", "api"],
    });
  });

  it("a syntactically valid but EMPTY edges array is a real, successful result — not an error", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify({ edges: [] }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result).toEqual({ ok: true, edges: [] });
  });

  it("loads the real OTel-trace-export row shape (viaQueue/kind/spanName/operation/count/sampleTraceIds), not just the minimal {from,to}", async () => {
    // The exact shape a real trace-export producer emitted — was rejected by
    // the pre-pivot strict {from,to}-only schema; this locks in the fix.
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({
        edges: [
          {
            from: "web-app",
            to: "worker",
            kind: "consumer",
            viaQueue: true,
            spanName: "jobs.process web_jobs",
            operation: "jobs.receive",
            count: 25,
            sampleTraceIds: ["abc123", "def456"],
          },
        ],
      }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.edges).toEqual([
      {
        from: "web-app",
        to: "worker",
        kind: "consumer",
        viaQueue: true,
        spanName: "jobs.process web_jobs",
        operation: "jobs.receive",
        count: 25,
        sampleTraceIds: ["abc123", "def456"],
      },
    ]);
  });

  it("loads the real external-host row shape too (edgeKind/rawHosts, no viaQueue/kind) — the OTHER real shape a trace export produces, for a call to a dependency outside the target repo entirely", async () => {
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({
        edges: [
          {
            from: "web-app",
            to: "config-service",
            edgeKind: "external",
            rawHosts: ["config-svc-slb", "config.example.com"],
            count: 4000,
            sampleTraceIds: ["905c9eca"],
          },
        ],
      }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.edges).toEqual([
      {
        from: "web-app",
        to: "config-service",
        edgeKind: "external",
        rawHosts: ["config-svc-slb", "config.example.com"],
        count: 4000,
        sampleTraceIds: ["905c9eca"],
      },
    ]);
  });

  it("a genuinely unknown extra key on a real-shaped row still fails loudly — widening the schema is not the same as .passthrough()", async () => {
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({ edges: [{ from: "a", to: "b", viaQueue: true, unknownField: 1 }] }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
  });

  it("an EXPLICIT empty observableComponents array loads successfully and is distinguishable from omitting the field", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify({ observableComponents: [], edges: [] }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result).toEqual({ ok: true, edges: [], observableComponents: [] });
  });

  it("the OLD bare-array shape from the original PR8 merge is now a schema violation, not silently accepted", async () => {
    // This is the breaking shape change — see loadObservedEdges' own doc.
    // A caller still on the old file format must get a loud, actionable
    // error, not a quiet reinterpretation.
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify([{ from: "web", to: "api" }]), "utf8");
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("failed schema validation");
  });

  it("a missing file is a loud error, never a silent empty list", async () => {
    const result = await loadObservedEdges(join(dir, "does-not-exist.json"));
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("cannot read");
  });

  it("invalid JSON is a loud error", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, "{not json", "utf8");
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("not valid JSON");
  });

  it("a row missing `to` fails schema validation loudly", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify({ edges: [{ from: "web" }] }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("failed schema validation");
  });

  it("an unknown extra key on an edge row fails loudly (strict schema) — a typo must not silently drop the row", async () => {
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({ edges: [{ from: "web", to: "api", weight: 3 }] }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
  });

  it("an unknown extra key on the OUTER object also fails loudly (strict schema)", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify({ edges: [], unknownField: "typo" }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    // Confirms it's the STRICT-schema check catching this (not some unrelated
    // failure that would also happen to report ok:false).
    expect((result as { ok: false; error: string }).error).toContain("failed schema validation");
  });

  /**
   * JSON has no comments, and this file is one a human maintains and has to
   * justify — "why does `observableTargetKinds` list these three and not
   * `datastore`?" is obvious the day it is written and unrecoverable six months
   * later. `_`-prefixed keys are the escape hatch (the same convention
   * `.codeontic/config.json` already uses in the wild), while strictness keeps
   * doing the job it is actually for: catching typos.
   */
  it("a `_`-prefixed annotation key is allowed through — strictness is for typos, not for forbidding notes", async () => {
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({ _note: "only HTTP is observable here", edges: [{ from: "a", to: "b" }] }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(true);
  });

  it("a near-miss typo still fails loudly, and the message says how to annotate instead", async () => {
    const file = join(dir, "edges.json");
    // `observableComponent` — singular, a plausible slip. Must NOT pass.
    await writeFile(file, JSON.stringify({ observableComponent: ["web"], edges: [] }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    const err = (result as { ok: false; error: string }).error;
    expect(err).toContain("observableComponent");
    expect(err).toContain("must start with '_'");
  });

  it("several unknown keys aggregate into ONE issue listing them all, like zod's own strict()", async () => {
    const file = join(dir, "edges.json");
    await writeFile(
      file,
      JSON.stringify({ observableComponent: ["web"], edgse: [], edges: [] }),
      "utf8",
    );
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    const err = (result as { ok: false; error: string }).error;
    // Both offenders named in one message — not one message per key.
    expect(err).toContain("observableComponent");
    expect(err).toContain("edgse");
  });

  it("missing the required `edges` key entirely fails loudly, not silently treated as empty", async () => {
    const file = join(dir, "edges.json");
    await writeFile(file, JSON.stringify({ observableComponents: ["web"] }), "utf8");
    const result = await loadObservedEdges(file);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("failed schema validation");
  });
});

// ─── renderTopologyHtml with an edge diff ────────────────────────────────

describe("renderTopologyHtml — edgeDiff rendering", () => {
  function sampleDiffModel() {
    return computeTopologyModel(
      [fact({ filePath: "apps/web/a.ts", topology: { to: "postgres", toKind: "datastore" } })],
      [WEB],
      true,
    );
  }

  it("omitting edgeDiff renders no diff markup at all — the flag-off path is unaffected", () => {
    const html = renderTopologyHtml(sampleDiffModel(), { title: "t" });
    // The CSS rule for #tg-edgediff-legend is always in the stylesheet (cheap,
    // harmless bytes) — what must be absent is the actual rendered element.
    expect(html).not.toContain('<div id="tg-edgediff-legend">');
    expect(html).not.toContain("静态覆盖率");
  });

  it("shows the 5-category legend when a diff ran; the coverage number itself is withheld here since denominator=1 is below the small-sample threshold", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "postgres" }]);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).toContain("tg-edgediff-legend");
    expect(html).toContain("双向确认");
    expect(html).toContain("仅静态提取");
    expect(html).toContain("仅观测到");
    expect(html).toContain("不可观测");
    expect(html).toContain("队列中介");
    expect(html).toContain("静态覆盖率");
    // confirmed=1, staticOnly=0 → denominator=1 < MIN_COVERAGE_SAMPLE — a
    // real incident showed "1/1 = 100%" reads as authoritative as a real
    // sample despite carrying almost no information (see staticCoverage's
    // own doc). The dedicated MIN_COVERAGE_SAMPLE describe block below has
    // the percentage-actually-shown case at a size where it's meaningful.
    expect(html).not.toContain("= 100%");
    expect(html).toContain("1/1（不给百分比");
  });

  it("shows the queue-mediated bucket's own count and excludes it from the coverage denominator, distinctly from unobservable", () => {
    const model = sampleDiffModel(); // one static edge: web -> postgres (toKind: datastore)
    const diff = computeTopologyEdgeDiff(
      model,
      [{ from: "web", to: "some-consumer", viaQueue: true }],
      { observableComponents: ["web"], observableTargetKinds: ["datastore"] },
    );
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    // web->postgres has no observed match, source IS in scope, and "datastore"
    // IS in the declared target-kind scope → static-only (1), confirmed 0 →
    // denominator 1 — but 1 < MIN_COVERAGE_SAMPLE, so no percentage is shown
    // (see the coverage-formula test above for why). The point THIS test is
    // actually checking — queue-mediated excluded from the denominator,
    // distinctly from unobservable — holds regardless.
    expect(html).not.toContain("= 0%");
    expect(html).toContain("0/1（不给百分比");
    expect(diff.summary.queueMediated).toBe(1);
    expect(diff.summary.unobservable).toBe(0);
  });

  it("shows BOTH observability-default banners (source scope + target-kind scope) when neither was declared", () => {
    const model = sampleDiffModel();
    // No `via` topology fact matches, and no 3rd option — a would-be
    // static-only edge exists (nothing else observed) so the undeclared-
    // scope path is actually exercised, not vacuously true.
    const diff = computeTopologyEdgeDiff(model, []);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).toContain("未声明可观测组件范围");
    expect(html).toContain("不代表这些边被判定为死路径");
    expect(html).toContain("未声明可观测目标类型");
  });

  it("hides the source-scope banner once observableComponents IS declared, but the target-kind banner is a SEPARATE flag and still shows (only observableComponents was declared here)", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).not.toContain("未声明可观测组件范围");
    expect(html).toContain("未声明可观测目标类型");
  });

  it("hides BOTH observability-default banners once both scopes are declared", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [], {
      observableComponents: ["web"],
      observableTargetKinds: ["datastore"],
    });
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).not.toContain("未声明可观测组件范围");
    expect(html).not.toContain("未声明可观测目标类型");
  });

  it("shows the self-loop exclusion note when the diff had one, and stays silent when it didn't", () => {
    const model = sampleDiffModel();
    const withLoop = computeTopologyEdgeDiff(model, [{ from: "web", to: "web" }]);
    const withoutLoop = computeTopologyEdgeDiff(model, [{ from: "web", to: "postgres" }]);
    expect(renderTopologyHtml(model, { title: "t" }, { status: "ok", diff: withLoop })).toContain(
      "排除了 1 条",
    );
    expect(
      renderTopologyHtml(model, { title: "t" }, { status: "ok", diff: withoutLoop }),
    ).not.toContain("排除了");
  });

  it("shows the naming-similarity hint banner with both ids named, and stays silent when there are no hints", () => {
    const model = computeTopologyModel(
      [fact({ filePath: "apps/web/a.ts", topology: { to: "redis-cache", toKind: "external" } })],
      [WEB],
      true,
    );
    const withHint = computeTopologyEdgeDiff(model, [{ from: "web", to: "cache" }], {
      observableComponents: ["web"],
      observableTargetKinds: ["external"],
    });
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff: withHint });
    expect(html).toContain("cache ↔ redis-cache");
    expect(html).toContain("不是自动合并");

    // A genuinely dissimilar observed-only id, WITH the same scope declared
    // (so the matching logic actually runs, not just "no data to compare") —
    // proves the banner is conditioned on a REAL absence of hits, not on an
    // empty diff being vacuously hint-free.
    const noHint = computeTopologyEdgeDiff(model, [{ from: "web", to: "unrelated-thing" }], {
      observableComponents: ["web"],
      observableTargetKinds: ["external"],
    });
    expect(noHint.nameSimilarityHints).toEqual([]); // sanity: the algorithm really found nothing
    expect(renderTopologyHtml(model, { title: "t" }, { status: "ok", diff: noHint })).not.toContain(
      "目标名字很像",
    );
  });

  it("shows n/a WITH a reason (not a bare 0%/100%) when the undeclared-scope default zeroes out the denominator", () => {
    const model = sampleDiffModel(); // one static edge, no observableComponents declared
    const diff = computeTopologyEdgeDiff(model, []);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    // The reason must actually be STATED, not just "n/a" on its own — a bare
    // "n/a" is exactly the kind of unexplained signal this feature exists to
    // avoid (see staticCoverageNaReason's own doc for why this is one of
    // three distinct causes, checked in order).
    expect(html).toContain("n/a（");
    expect(html).toContain("observableComponents");
    // Not "= 0%" or "= 100%" — those are the two specific wrong readings a
    // fallback-to-zero implementation would show instead of "no comparison ran".
    expect(html).not.toContain("= 0%");
    expect(html).not.toContain("= 100%");
  });

  it("shows n/a with a DIFFERENT reason when the static side has no edges at all", () => {
    const model = computeTopologyModel([], [WEB], true); // zero static edges
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "postgres" }]);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).toContain("n/a（");
    expect(html).toContain("静态提取没有产出任何边");
  });

  it("shows the empty-observed-data warning, distinct from the observability-scope warning, when the file's edges array is empty", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [], { observableComponents: ["web"] });
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).toContain("edges 是空的");
    expect(html).not.toContain("未声明可观测范围"); // scope WAS declared here — must not conflate the two warnings
  });

  it("shows a loud ✗ banner (never a silent empty diff) when the outcome is an error", () => {
    const model = sampleDiffModel();
    const html = renderTopologyHtml(model, { title: "t" }, { status: "error", message: "boom" });
    expect(html).toContain("✗");
    expect(html).toContain("boom");
    // no diff rendered — error, not a degrade to an empty-but-present diff section
    expect(html).not.toContain('<div id="tg-edgediff-legend">');
    expect(html).not.toContain("静态覆盖率");
  });

  it("degrades honestly: an id an observed edge names, that nothing else has ever heard of, still appears as a labeled node", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "some-unknown-service" }]);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).toContain("some-unknown-service");
    expect(html).toContain("只在观测边里出现的节点"); // the dedicated legend line for this case
  });

  it("hides that legend line when every observed id is already known (no extra nodes)", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "postgres" }]);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    expect(html).not.toContain("只在观测边里出现的节点");
  });

  it("stays self-contained (no external hosts) with a diff embedded", () => {
    const model = sampleDiffModel();
    const diff = computeTopologyEdgeDiff(model, [{ from: "web", to: "postgres" }]);
    const html = renderTopologyHtml(model, { title: "t" }, { status: "ok", diff });
    const urls = html.match(/https?:\/\/[^\s"')]+/g) ?? [];
    for (const u of urls) expect(u).toBe("http://www.w3.org/2000/svg");
  });
});

// ─── runTopology / CLI — --compare-edges ─────────────────────────────────

describe("runTopology / CLI — --compare-edges", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "codeontic-compare-edges-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function seed(): Promise<string> {
    await mkdir(join(workDir, ".codeontic"), { recursive: true });
    await writeFile(
      join(workDir, ".codeontic", "config.json"),
      JSON.stringify({ components: [{ id: "web", role: "frontend", paths: ["apps/web"] }] }),
      "utf8",
    );
    const adapterFile = await writeAdapterFile(workDir);
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workDir });
    await mkdir(join(workDir, "apps", "web"), { recursive: true });
    await writeFile(join(workDir, "apps", "web", "a.ts"), "callDb();\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });
    return adapterFile;
  }

  it("--compare-edges absent → no edge-diff line AND no diff markup in the written HTML, identical to pre-existing behavior", async () => {
    const adapterFile = await seed();
    const logs: string[] = [];
    const code = await run(
      ["topology", workDir, "--repo-root", workDir, "--adapter-path", adapterFile, "--no-cache"],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("edge diff:"))).toBe(false);
    expect(logs.some((l) => l.startsWith("ERR:"))).toBe(false);
    // Guards the FULL wiring (runTopology → renderTopologyHtml), not just the
    // renderer in isolation (see the renderTopologyHtml describe block above)
    // — this is the path that would actually regress if a future edit made
    // the CLI pass an `edgeDiff` argument unconditionally.
    const written = logs.find((l) => l.startsWith("wrote "));
    if (!written) throw new Error("no 'wrote <path>' line");
    const html = await readFile(written.slice("wrote ".length), "utf8");
    expect(html).not.toContain('<div id="tg-edgediff-legend">');
  });

  it("a matching --compare-edges file prints the 5-bucket counts and static coverage", async () => {
    const adapterFile = await seed();
    const edgesFile = join(workDir, "observed.json");
    await writeFile(
      edgesFile,
      JSON.stringify({ edges: [{ from: "web", to: "postgres" }] }),
      "utf8",
    );

    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        edgesFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith("ERR:"))).toBe(false);
    expect(
      logs.some(
        (l) =>
          l.includes(
            "edge diff: 1 confirmed / 0 static-only / 0 observed-only / 0 unobservable / 0 queue-mediated",
          ) && l.includes("1/1 (no percentage:"), // denominator=1 < MIN_COVERAGE_SAMPLE — counts shown, ratio withheld
      ),
    ).toBe(true);

    const written = logs.find((l) => l.startsWith("wrote "));
    if (!written) throw new Error("no 'wrote <path>' line");
    const html = await readFile(written.slice("wrote ".length), "utf8");
    expect(html).toContain("tg-edgediff-legend");
  });

  it("undeclared observableComponents: a static-only edge (adapter extracted, never observed) is reported as unobservable, with a loud CLI warning AND the empty-observed-data warning (edges: [] here)", async () => {
    const adapterFile = await seed();
    const edgesFile = join(workDir, "observed.json");
    // Empty observed edges — the adapter's own db_call→postgres edge (see
    // writeAdapterFile) has nothing to match, so it would be static-only —
    // except observableComponents is never declared here.
    await writeFile(edgesFile, JSON.stringify({ edges: [] }), "utf8");

    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        edgesFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(
      logs.some((l) =>
        l.includes(
          "edge diff: 0 confirmed / 0 static-only / 0 observed-only / 1 unobservable / 0 queue-mediated",
        ),
      ),
    ).toBe(true);
    expect(
      logs.some((l) => l.includes("no observableComponents declared") && l.includes("⚠")),
    ).toBe(true);
    // edges: [] really is empty here — both warnings are independently true
    // and must BOTH show, not just whichever one the implementation checks first.
    expect(logs.some((l) => l.includes("edges array is empty"))).toBe(true);
    // denominator (confirmed+staticOnly) is 0 here too — n/a with a reason
    // naming the undeclared scope, not the empty observed data (see
    // staticCoverageNaReason's ordering: scope-undeclared is checked before
    // "no comparable edges" would even matter).
    expect(logs.some((l) => l.includes("n/a (") && l.includes("observableComponents"))).toBe(true);
  });

  it("declared observableComponents including the edge's source: the same missing edge is now static-only, and the scope warning disappears while the empty-observed-data warning still fires (coverage percentage itself is withheld — denominator=1 is below the small-sample threshold)", async () => {
    const adapterFile = await seed();
    const edgesFile = join(workDir, "observed.json");
    // The seeded adapter's db_call fact tags `toKind: "datastore"` (see
    // writeAdapterFile) — observableTargetKinds must ALSO cover it for the
    // edge to reach static-only, same as observableComponents on the source
    // side.
    await writeFile(
      edgesFile,
      JSON.stringify({
        observableComponents: ["web"],
        observableTargetKinds: ["datastore"],
        edges: [],
      }),
      "utf8",
    );

    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        edgesFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(
      logs.some((l) =>
        l.includes(
          "edge diff: 0 confirmed / 1 static-only / 0 observed-only / 0 unobservable / 0 queue-mediated",
        ),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("no observableComponents declared"))).toBe(false);
    // Scope WAS declared, so the edge itself reaches static-only, not
    // unobservable — but denominator=1 < MIN_COVERAGE_SAMPLE, so the CLI
    // shows the raw count instead of a bare "0/1 = 0%" percentage. The
    // observed data was still empty, so that (independent) warning fires too.
    expect(logs.some((l) => l.includes("0/1 (no percentage:"))).toBe(true);
    expect(logs.some((l) => l.includes("edges array is empty"))).toBe(true);
  });

  it("all-empty: no static edges AND no observed edges — every count is 0, and staticCoverage is n/a for the 'static side has no edges' reason, not silently 0%/100%", async () => {
    // Seed a repo whose adapter fixture NEVER produces a topology fact — an
    // empty `apps/web/a.ts` body, no `callDb()` — so the static side truly
    // has zero edges (not just zero observable ones).
    await mkdir(join(workDir, ".codeontic"), { recursive: true });
    await writeFile(
      join(workDir, ".codeontic", "config.json"),
      JSON.stringify({ components: [{ id: "web", role: "frontend", paths: ["apps/web"] }] }),
      "utf8",
    );
    const adapterFile = await writeAdapterFile(workDir);
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workDir });
    await mkdir(join(workDir, "apps", "web"), { recursive: true });
    await writeFile(join(workDir, "apps", "web", "a.ts"), "// no calls here\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });

    const edgesFile = join(workDir, "observed.json");
    await writeFile(edgesFile, JSON.stringify({ edges: [] }), "utf8");

    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        edgesFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(
      logs.some((l) =>
        l.includes(
          "edge diff: 0 confirmed / 0 static-only / 0 observed-only / 0 unobservable / 0 queue-mediated",
        ),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("n/a (") && l.includes("静态提取没有产出任何边"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("edges array is empty"))).toBe(true);
  });

  it("a bad --compare-edges file: loud ✗ error, but topology STILL renders and exits 0 (advisory contract preserved)", async () => {
    const adapterFile = await seed();
    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        join(workDir, "does-not-exist.json"),
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0); // topology is advisory/read-only end to end — never flips exit code
    expect(
      logs.some(
        (l) => l.startsWith("ERR:") && l.includes("--compare-edges") && l.includes("cannot read"),
      ),
    ).toBe(true);
    // The main topology output still got written — only the diff sub-feature failed.
    expect(logs.some((l) => l.startsWith("wrote "))).toBe(true);
    // Coverage line must NOT appear — a bad file must never look like "0 observed edges, n/a".
    expect(logs.some((l) => l.includes("edge diff:"))).toBe(false);
  });

  it("a --compare-edges file that EXISTS but is malformed JSON: same loud-✗-but-exit-0 treatment as a missing file", async () => {
    const adapterFile = await seed();
    const badFile = join(workDir, "observed.json");
    await writeFile(badFile, "{not valid json", "utf8");
    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        badFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(
      logs.some(
        (l) =>
          l.startsWith("ERR:") && l.includes("--compare-edges") && l.includes("not valid JSON"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.startsWith("wrote "))).toBe(true);
    expect(logs.some((l) => l.includes("edge diff:"))).toBe(false);
  });

  it("--compare-edges given with no value is rejected loudly (same convention as --repo-root/--out)", async () => {
    const logs: string[] = [];
    const code = await run(["topology", workDir, "--compare-edges"], {
      log: (l) => logs.push(l),
      error: (l) => logs.push(`ERR:${l}`),
    });
    expect(code).toBe(1);
    expect(
      logs.some((l) => l.startsWith("ERR:") && l.includes("--compare-edges requires a value")),
    ).toBe(true);
  });

  it("an observed edge naming an id nothing else declared degrades honestly instead of crashing or silently dropping it", async () => {
    const adapterFile = await seed();
    const edgesFile = join(workDir, "observed.json");
    await writeFile(
      edgesFile,
      JSON.stringify({ edges: [{ from: "web", to: "some-mystery-dependency" }] }),
      "utf8",
    );
    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        edgesFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith("ERR:"))).toBe(false);
    const written = logs.find((l) => l.startsWith("wrote "));
    if (!written) throw new Error("no 'wrote <path>' line");
    const html = await readFile(written.slice("wrote ".length), "utf8");
    expect(html).toContain("some-mystery-dependency");
  });

  it("end to end: observableTargetKinds, self-loop exclusion, and a naming-similarity hint all surface in the CLI output together", async () => {
    const adapterFile = await seed();
    const edgesFile = join(workDir, "observed.json");
    await writeFile(
      edgesFile,
      JSON.stringify({
        observableComponents: ["web"],
        observableTargetKinds: ["datastore"],
        edges: [
          { from: "web", to: "web" }, // self-loop artifact — must be excluded, not counted
          { from: "web", to: "postgres-db" }, // similar to static's "postgres" — hint, not auto-merge
        ],
      }),
      "utf8",
    );
    const logs: string[] = [];
    const code = await run(
      [
        "topology",
        workDir,
        "--repo-root",
        workDir,
        "--adapter-path",
        adapterFile,
        "--no-cache",
        "--compare-edges",
        edgesFile,
      ],
      { log: (l) => logs.push(l), error: (l) => logs.push(`ERR:${l}`) },
    );
    expect(code).toBe(0);
    // The seeded adapter's only static edge (web -> postgres, toKind:
    // datastore) has no exact observed match ("postgres-db" is a DIFFERENT
    // key) and both scopes cover it → static-only, not unobservable.
    expect(
      logs.some((l) =>
        l.includes(
          "edge diff: 0 confirmed / 1 static-only / 1 observed-only / 0 unobservable / 0 queue-mediated",
        ),
      ),
    ).toBe(true);
    expect(
      logs.some((l) => l.includes("excluded 1 self-referencing edge") && l.includes("ℹ")),
    ).toBe(true);
    expect(
      logs.some((l) => l.includes("postgres-db ↔ postgres") && l.includes("not auto-merged")),
    ).toBe(true);
  });
});
