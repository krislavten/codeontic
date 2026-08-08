import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli/run.js";
import { buildGraph } from "../src/loader/model-graph.js";
import { computeConformance } from "../src/query/conformance.js";
import type { DebtEntry, Flow, Junction, Loop, Scenario } from "../src/schema/index.js";
import {
  computeArchitecture,
  computeOverviewModel,
  moduleKeyOf,
  renderOverviewHtml,
  repoLinks,
} from "../src/views/overview-html.js";
import type { OverviewMeta } from "../src/views/overview-html.js";
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
function debt(overrides: Partial<DebtEntry> & Pick<DebtEntry, "id">): DebtEntry {
  return {
    kind: "debt",
    category: "dead_state_machine",
    subject: "a status column nothing ever advances",
    reality: "no writer transitions it",
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

const META: OverviewMeta = { title: "t", repoResolved: true };

/** Record<string, T> access is `T | undefined` under noUncheckedIndexedAccess. */
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a defined value");
  return v;
}

describe("computeOverviewModel — structure & status", () => {
  it("renders text-anchored scenarios as bound tests, not as 'no tests' (016 T6)", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      {
        file: "b",
        node: scenario({
          id: "GWT-C1-001",
          verified_by_text: [{ file: "test/a.test.ts", text: "does the thing" }],
        }),
      },
    ]);
    const conf = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });
    const m = computeOverviewModel(graph, conf, new Set(["src/a.ts", "test/a.test.ts"]));
    const tests = need(m.loops.L1).scenarios[0]?.tests ?? [];
    expect(tests).toHaveLength(1);
    expect(need(tests[0]).file).toBe("test/a.test.ts");
    expect(need(tests[0]).ok).toBe(true);
    expect(need(tests[0]).ref).toContain('"does the thing"');
  });

  /**
   * `OverviewFlow` carried no `scenarios` field at all until the flow drawer
   * existed: a flow could hold a fully bound GWT (13 of pi-full's 19 flows do)
   * and the page showed nothing but a title — F2b's whole point, invisible.
   *
   * BOTH test-anchor forms are asserted because the loop side shipped exactly
   * this omission once (016 T6: a text-anchored scenario rendered as "no tests"
   * while conformance said test✓), and a second scenario builder is precisely
   * where it would grow back. They share one builder for that reason.
   */
  it("carries a flow's OWN scenarios, resolving both test-anchor forms (F2b)", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C1",
          anchors: ["src/a.ts#F"],
          scenarios: ["GWT-C1-001", "GWT-C1-002", "GWT-GHOST-001"],
        }),
      },
      {
        file: "b",
        node: scenario({
          id: "GWT-C1-001",
          given: "G",
          when: "W",
          verified_by: ["test/a.test.ts#A"],
        }),
      },
      {
        file: "c",
        node: scenario({
          id: "GWT-C1-002",
          verified_by_text: [{ file: "test/b.test.ts", text: "does the thing" }],
        }),
      },
    ]);
    const files = new Set(["src/a.ts", "test/a.test.ts", "test/b.test.ts"]);
    const m = computeOverviewModel(
      graph,
      computeConformance(graph, { existingFiles: files }),
      files,
    );

    const f = need(m.flows[0]);
    expect(f.scenarios).toHaveLength(3);
    expect(need(f.scenarios[0])).toMatchObject({ id: "GWT-C1-001", given: "G", when: "W" });
    expect(need(f.scenarios[0]).tests).toEqual([
      { ref: "test/a.test.ts#A", file: "test/a.test.ts", ok: true },
    ]);
    const textAnchored = need(need(f.scenarios[1]).tests?.[0]);
    expect(textAnchored.ref).toContain('"does the thing"');
    expect(textAnchored).toMatchObject({ file: "test/b.test.ts", ok: true });
    // a dangling id stays exactly {id, missing} — "not defined" must remain
    // distinguishable from "defined but empty"
    expect(f.scenarios[2]).toEqual({ id: "GWT-GHOST-001", missing: true });
  });

  it("keys loops, carries verdict/code/test and resolves anchor/test file existence", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      { file: "b", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
    ]);
    const conf = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });
    const m = computeOverviewModel(graph, conf, new Set(["src/a.ts", "test/a.test.ts"]));

    const l = need(m.loops.L1);
    expect(l.verdict).toBe("met");
    expect(l.anchors).toEqual([{ ref: "src/a.ts#A", file: "src/a.ts", ok: true }]);
    expect(need(l.scenarios[0]).tests).toEqual([
      { ref: "test/a.test.ts#A", file: "test/a.test.ts", ok: true },
    ]);
    expect(m.summary).toMatchObject({ loops: 1, met: 1 });
  });

  it("marks anchor ok=false when the file is absent, ok=null when repo not resolved", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/gone.ts#A"] }) },
    ]);

    const resolved = computeOverviewModel(
      graph,
      computeConformance(graph, { existingFiles: new Set() }),
      new Set(),
    );
    expect(need(resolved.loops.L1).anchors[0]?.ok).toBe(false);

    const structural = computeOverviewModel(graph, computeConformance(graph, {}));
    expect(need(structural.loops.L1).anchors[0]?.ok).toBeNull();
  });

  it("groups background loops (not in any flow, non-dormant) by base package, sorted by size", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"] }) },
      { file: "b", node: loop({ id: "L1", owner: "apps/x" }) }, // in flow → not background
      { file: "c", node: loop({ id: "L2", owner: "apps/bg" }) },
      { file: "d", node: loop({ id: "L3", owner: "apps/bg (仅退役窗口)" }) }, // parenthetical stripped
      { file: "e", node: loop({ id: "L4", owner: "packages/solo" }) },
      { file: "f", node: loop({ id: "N9", owner: null, dormant: true }) }, // dormant → excluded
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));

    expect(m.summary).toMatchObject({ loops: 5, inFlow: 1, background: 3 });
    // apps/bg has 2 (L2 + L3 with the qualifier stripped), sorted first
    expect(m.background[0]).toEqual({ owner: "apps/bg", ids: ["L2", "L3"] });
    expect(m.background.map((o) => o.owner)).not.toContain("apps/x"); // in-flow owner absent
  });

  it("counts only real loops as in-flow — a dangling traverses id must not inflate the stat", () => {
    // T0's referential-integrity check fails the build on a dangling reference,
    // but `overview` runs ungated, so the count has to hold on a broken model.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1", "L-GHOST"] }) },
      { file: "b", node: loop({ id: "L1" }) },
      { file: "c", node: loop({ id: "L2" }) },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));

    expect(m.summary.inFlow).toBe(1); // L1 only — L-GHOST resolves to no loop
    expect(m.summary.background).toBe(1); // L2
    // With no dormant loops present, in-flow and background partition the total.
    expect(m.summary.inFlow + m.summary.background).toBe(m.summary.loops);
  });

  it("counts dormant loops so the exclusion is visible rather than silent", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      { file: "b", node: loop({ id: "N9", owner: null, dormant: true }) },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));
    expect(m.summary.dormant).toBe(1);
    expect(m.summary.background).toBe(1); // dormant is NOT background
  });

  it("counts a dormant loop that a flow traverses in BOTH inFlow and dormant", () => {
    // `dormant` is a cross-cutting label (never graded), not a partition slot: a
    // dormant loop wired into a flow still renders as a chip there. Pinning the
    // overlap so the stats are read as "total / in-flow / background / dormant",
    // never as four numbers that must sum to the total.
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["N9"] }) },
      { file: "b", node: loop({ id: "N9", owner: null, dormant: true }) },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));
    expect(m.summary).toMatchObject({ loops: 1, inFlow: 1, background: 0, dormant: 1 });
  });

  it("carries flow.summary and lists a flow's ordered steps + crossing junctions", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: flow({
          id: "C1",
          title: "旅程",
          summary: "发消息到回复",
          traverses: ["L1", "L2"],
          crosses: ["J-h"],
        }),
      },
      { file: "b", node: loop({ id: "L1" }) },
      { file: "c", node: loop({ id: "L2" }) },
      { file: "d", node: junction({ id: "J-h", between: ["L1", "L2"] }) },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));
    const f = need(m.flows[0]);
    expect(f).toMatchObject({ id: "C1", summary: "发消息到回复", steps: ["L1", "L2"] });
    expect(f.junctions[0]).toMatchObject({ id: "J-h", risk: "handoff", between: ["L1", "L2"] });
    // and the loop back-references the junction that touches it
    expect(need(m.loops.L1).junctions[0]?.id).toBe("J-h");
  });

  it("resolves a scenario to GWT text + tests, and flags a dangling scenario id as missing", () => {
    const gwt = scenario({
      id: "GWT-C1-001",
      given: "G",
      when: "W",
      verified_by: ["test/a.test.ts#x"],
    });
    // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
    gwt.then = "T";
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", scenarios: ["GWT-C1-001", "GWT-GHOST-001"] }) },
      { file: "b", node: gwt },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));
    const l1 = need(m.loops.L1);
    const s0 = need(l1.scenarios[0]);
    expect(s0).toMatchObject({ id: "GWT-C1-001", given: "G", when: "W" });
    expect(s0.then).toBe("T");
    expect(l1.scenarios[1]).toEqual({ id: "GWT-GHOST-001", missing: true });
  });

  /**
   * 016 T7 — the outstanding ledger. Debt entries were previously not in the
   * overview payload AT ALL: the model's whole baseline (the "looks like
   * behavior, is actually dead" list) was invisible on the page that claims to
   * be the system map, and the met/partial/gap headline says nothing about them
   * because debt is not graded.
   *
   * Order is asserted, not just membership: debt → gap → partial is the order a
   * reader should triage in, and a set-equality assertion would let it degrade
   * to model iteration order unnoticed.
   */
  it("collects debt + every non-met node into an ordered outstanding ledger", () => {
    const { graph } = buildGraph([
      { file: "a", node: debt({ id: "DEBT-X", subject: "S", reality: "R", owner: "team" }) },
      // met: anchored + scenario with a test → must NOT appear in the ledger
      { file: "b", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-C1-001"] }) },
      { file: "c", node: scenario({ id: "GWT-C1-001", verified_by: ["test/a.test.ts#A"] }) },
      // partial: code present, nothing testing it
      { file: "d", node: loop({ id: "L2", anchors: ["src/a.ts#B"] }) },
      // gap: nothing anchored at all
      { file: "e", node: loop({ id: "L3" }) },
    ]);
    const conf = computeConformance(graph, {
      existingFiles: new Set(["src/a.ts", "test/a.test.ts"]),
    });
    const m = computeOverviewModel(graph, conf, new Set(["src/a.ts", "test/a.test.ts"]));

    expect(m.findings.map((f) => f.id)).toEqual(["DEBT-X", "L3", "L2"]);
    expect(m.findings.map((f) => f.row)).toEqual(["debt", "node", "node"]);
    expect(m.findings[0]).toMatchObject({ title: "S", reality: "R", owner: "team" });
    // debt is ungraded — it must not be dressed up with a verdict it never earned
    expect(m.findings[0]?.verdict).toBeUndefined();
    expect(m.findings[1]).toMatchObject({ verdict: "gap", kind: "loop", code: "missing" });
    expect(m.findings[2]).toMatchObject({ verdict: "partial", kind: "loop", test: "missing" });
    expect(m.summary).toMatchObject({ debts: 1, anchoredFiles: 1 });
  });

  /**
   * A junction that fails only on the test axis is ALREADY `partial`; giving
   * `test✗` junctions their own section would print the same row twice and make
   * the section counts irreconcilable with the headline. It rides along as an
   * axis flag on the row instead — asserted here so the badge data can't quietly
   * disappear.
   */
  it("carries a junction's failing axis on its ledger row rather than a second bucket", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
      { file: "b", node: loop({ id: "L2", anchors: ["src/a.ts#B"] }) },
      {
        file: "c",
        node: junction({
          id: "J-x",
          between: ["L1", "L2"],
          evidence: [{ id: "EV-1", kind: "code", anchor: "src/a.ts#A" }],
          scenarios: ["GWT-JX-001"],
        }),
      },
      // scenario exists but binds no test → the junction's test axis is missing
      { file: "d", node: scenario({ id: "GWT-JX-001" }) },
    ]);
    const m = computeOverviewModel(
      graph,
      computeConformance(graph, { existingFiles: new Set(["src/a.ts"]) }),
      new Set(["src/a.ts"]),
    );
    const jrow = m.findings.filter((f) => f.kind === "junction");
    expect(jrow).toHaveLength(1);
    expect(jrow[0]).toMatchObject({ id: "J-x", verdict: "partial", test: "missing" });
  });

  /**
   * Proposal 016 T4 let `Junction.between` hold a FlowId. Junctions used to hang
   * off LOOP cards only, so a junction between two flows named no loop, rendered
   * on no card, and was still graded into the met/partial/gap headline — a
   * verdict on the page that nothing on the page accounted for.
   */
  it("hangs a junction on the flow card when a flow is one of its endpoints (T4)", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"], crosses: ["J-declared"] }) },
      { file: "b", node: flow({ id: "C2" }) },
      { file: "c", node: loop({ id: "L1" }) },
      { file: "d", node: junction({ id: "J-declared", between: ["L1"] }) },
      // between names the flows directly, and NEITHER flow lists it in `crosses`
      { file: "e", node: junction({ id: "J-crossflow", between: ["C1", "C2"] }) },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));

    const c1 = need(m.flows.find((f) => f.id === "C1"));
    // declared-first, then endpoint-derived; the declared one is not duplicated
    expect(c1.junctions.map((j) => j.id)).toEqual(["J-declared", "J-crossflow"]);
    expect(need(m.flows.find((f) => f.id === "C2")).junctions.map((j) => j.id)).toEqual([
      "J-crossflow",
    ]);
  });

  it("does not duplicate a junction that is BOTH declared in crosses and an endpoint", () => {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", crosses: ["J-both"] }) },
      { file: "b", node: loop({ id: "L1" }) },
      { file: "c", node: junction({ id: "J-both", between: ["C1", "L1"] }) },
    ]);
    const m = computeOverviewModel(graph, computeConformance(graph, {}));
    expect(need(m.flows[0]).junctions.map((j) => j.id)).toEqual(["J-both"]);
    // …and the loop endpoint still sees it, exactly once
    expect(need(m.loops.L1).junctions.map((j) => j.id)).toEqual(["J-both"]);
  });
});

describe("renderOverviewHtml — self-contained & safe", () => {
  function sample() {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"] }) },
      { file: "b", node: loop({ id: "L1", anchors: ["src/a.ts#A"] }) },
    ]);
    return computeOverviewModel(graph, computeConformance(graph, {}));
  }

  it("references no external host at all", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html.match(/https?:\/\//g)).toBeNull();
    expect(html).not.toContain("<script src");
  });

  it("embeds the model as an inline JSON island and carries meta", () => {
    const html = renderOverviewHtml(sample(), { ...META, title: "my-model" });
    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const json = m?.[1];
    if (json === undefined) throw new Error("data island not found");
    const p = JSON.parse(json.replace(/\\u003c/g, "<"));
    expect(p.data.loops.L1).toBeTruthy();
    expect(p.meta.title).toBe("my-model");
  });

  it("escapes a </script> hidden in a loop title so it can't break the island", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1", title: "x </script><script>alert(1)</script>" }) },
    ]);
    const html = renderOverviewHtml(
      computeOverviewModel(graph, computeConformance(graph, {})),
      META,
    );
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("ships an esc() that also escapes double quotes, so attribute contexts are safe", () => {
    // data-loop="..." is an attribute; text-node serialization alone does NOT
    // escape `"`, so esc() must. Guards against a future free-text value being
    // dropped into an attribute and breaking out of it.
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain('.replace(/"/g,"&quot;")');
  });

  it("surfaces model provenance (generatedAt + model hash) when supplied", () => {
    const html = renderOverviewHtml(sample(), {
      ...META,
      generatedAt: "2026-07-22T00:00:00.000Z",
      modelHash: "abcdef0123456789",
    });
    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const p = JSON.parse((m?.[1] ?? "{}").replace(/\\u003c/g, "<"));
    expect(p.meta.generatedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(p.meta.modelHash).toBe("abcdef0123456789");
  });

  /**
   * 016 T5. A map with no coverage number reads as the whole system — the first
   * runs produced a 3-file model that called itself a system map. Both halves
   * are asserted, and so is the CALIBER sentence: file/commit reach measures how
   * thoroughly the code was searched, and the moment the page lets that be read
   * as business completeness the number does more harm than its absence.
   */
  it("states the coverage numbers AND what they are not (T5)", () => {
    const html = renderOverviewHtml(sample(), { ...META, commitTouch: { hit: 13, total: 26 } });
    expect(html).toContain("绑定了");
    expect(html).toContain("commitTouch");
    expect(html).toContain("机器数不出来");
    expect(html).toContain("该建模的行为有没有漏画");
    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const p = JSON.parse((m?.[1] ?? "{}").replace(/\\u003c/g, "<"));
    expect(p.meta.commitTouch).toEqual({ hit: 13, total: 26 });
    expect(p.data.summary.anchoredFiles).toBe(1);
  });

  /**
   * 016 D7. The no-flow bucket's criterion is exactly "no flow references it".
   * The page used to ASSERT what those loops are ("the always-on machinery:
   * credential refresh, TTL renewal, …") — on a real 30-loop model 21 loops
   * landed there including the main REPL loop, so the assertion was simply
   * false. The section must state its criterion and let the reader conclude.
   */
  it("describes the no-flow bucket by its criterion, never by what it assumes those loops are (D7)", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).not.toContain("一直在后台运转的机器");
    expect(html).not.toContain("凭证刷新、TTL 续租");
    expect(html).toContain("不在任何链路里的 loop");
    expect(html).toContain("进这一栏只有一个原因");
  });

  /**
   * The debt category is a schema enum (`dead_state_machine` / `deferred` /
   * `other`). The ledger rows are read by people, and an internal slug is never
   * the primary information a reader gets — the page already translates every
   * other enum it shows (verdicts, gap kinds). Asserted against the rendered
   * source because the translation lives in the inline script.
   */
  it("renders debt categories as words, not schema enum slugs", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain("死状态机");
    expect(html).toContain("DEBTCAT[f.category]||f.category"); // and degrades visibly
  });

  /**
   * A flow is the USER JOURNEY — the entry point a human reads the system
   * through — and until now it was the one node kind with no drawer: a card
   * with a title, a chain and nothing openable. The report's second question
   * ("how is it wired together") was answered halfway.
   *
   * Asserted against the rendered source, same as the other inline-script
   * behavior in this file. Real click-through (C1 composed / C10 anchored /
   * step → loop) was verified headless against the 60-node pi model.
   */
  it("makes the flow header a drawer handle and gives the flow its own drawer", () => {
    const html = renderOverviewHtml(sample(), META);
    // the handle is the id+title only — never the whole card, which already
    // contains step/guard chips with their own click targets
    expect(html).toContain('<button class="fhead" data-flow="');
    expect(html).toContain("function showFlow(id)");
    // loop is matched FIRST: a step chip lives inside the flow drawer. The
    // selector is NOT scoped to .chip — the panorama's SVG nodes carry the same
    // attributes and must open the same drawers.
    expect(html).toContain('var b=t.closest("[data-loop]")');
    expect(html).toContain('var g=t.closest("[data-flow]")');
    // steps render as loop chips, so each step opens that loop's own drawer
    expect(html).toContain('class="dsteps"');
    // the two blocks are SHARED with the loop drawer, not re-implemented
    expect(html).toContain("function scenarioRows(list,emptyText)");
    expect(html).toContain("function junctionRows(list,label)");
    expect(html).toContain("h+=scenarioRows(f.scenarios,");
    expect(html).toContain("h+=junctionRows(f.junctions,");
    // and the flow's own anchors + both conformance axes are spelled out
    expect(html).toContain("链路自己的代码");
    expect(html).toContain("代码 ✗");
    expect(html).toContain("测试 ✗");
  });

  /**
   * A composition-only flow has no verdict of its own by design (its loops
   * carry the score; grading it too would double-count). The drawer must SAY
   * that where a loop shows its status, not leave a blank box the reader reads
   * as "unknown/broken".
   */
  it("explains a composed flow's missing verdict instead of leaving the status box empty", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain("这是一条组合链路");
    expect(html).toContain("看每一步 loop 自己的圆点");
  });

  /**
   * The outstanding ledger is the page's first block, and a flow row there used
   * to be dead text while a loop row was a chip — two rows that mean the same
   * thing behaving differently. Both are chips now, off the same builder.
   */
  it("gives a flow ledger row the same clickable chip a loop row gets", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain("function flowChip(id)");
    expect(html).toContain("L[f.id]?chip(f.id):(F[f.id]?flowChip(f.id)");
    expect(html).toContain('data-flow="');
  });

  /**
   * Selection is a claim about what the drawer is showing. Clearing only
   * `.chip.sel` (the loop-era selector) would leave a flow header lit after a
   * loop opened, so the page would claim two things were open at once.
   */
  it("clears the selection across BOTH handle kinds when any drawer opens", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain('document.querySelectorAll(".sel")');
    expect(html).toContain("function openDrawer(html,selector)");
  });

  it("is a pure function of (model, meta) — same input renders identical bytes", () => {
    const m = sample();
    expect(renderOverviewHtml(m, META)).toBe(renderOverviewHtml(m, META));
  });

  it("carries the code-link base into the island so files become clickable GitHub links", () => {
    const html = renderOverviewHtml(sample(), {
      ...META,
      blobBase: "https://github.com/o/r/blob/abc/",
      repoHref: "https://github.com/o/r",
      repoLabel: "o/r @ abc",
    });
    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const p = JSON.parse((m?.[1] ?? "{}").replace(/\\u003c/g, "<"));
    expect(p.meta.blobBase).toBe("https://github.com/o/r/blob/abc/");
    expect(p.meta.repoLabel).toBe("o/r @ abc");
  });
});

describe("repoLinks — remote URL → code-link base", () => {
  const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"; // 40 hex

  it("parses the common github remote forms to a /blob/<ref>/ base", () => {
    for (const url of [
      "git@github.com:acme/widgets.git",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets",
      "ssh://git@github.com/acme/widgets.git",
    ]) {
      const r = repoLinks(url, SHA);
      expect(r?.blobBase).toBe(`https://github.com/acme/widgets/blob/${SHA}/`);
      expect(r?.repoHref).toBe("https://github.com/acme/widgets");
      expect(r?.repoLabel).toBe("acme/widgets @ 1a2b3c4"); // 40-hex sha shortened to 7
    }
  });

  it("uses gitlab's /-/blob/ path and keeps subgroups", () => {
    const r = repoLinks("git@gitlab.com:grp/sub/proj.git", "main");
    expect(r?.blobBase).toBe("https://gitlab.com/grp/sub/proj/-/blob/main/");
    expect(r?.repoLabel).toBe("grp/sub/proj @ main"); // non-sha ref kept verbatim
  });

  it("returns null for an unparseable remote", () => {
    expect(repoLinks("not-a-remote", SHA)).toBeNull();
    expect(repoLinks("", SHA)).toBeNull();
  });
});

describe("runOverview / CLI — against the synthetic seed model", () => {
  let workDir: string;
  async function touch(rel: string) {
    const abs = join(workDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "// x\n");
  }
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "codeontic-overview-test-"));
    await seedSyntheticModel(workDir);
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes a self-contained overview.html to ws/ and exits 0", async () => {
    await touch("src/synth/main.ts");
    await touch("test/synth/handoff.test.ts");
    const lines: string[] = [];
    const code = await run(["overview", workDir, "--repo-root", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("overview:");
    expect(out).toContain("wrote ");
    const html = await readFile(join(workDir, ".codeontic", "ws", "overview.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("系统地图");
    expect(html.match(/https?:\/\//g)).toBeNull(); // self-contained
  });

  /**
   * 016 D7, CLI side. The summary line said "N background" — a CONCLUSION the
   * number does not support: the bucket's only criterion is "no flow references
   * it", and on the 30-loop pi model 21 loops landed there including the main
   * REPL loop. The page was already fixed to state the criterion; this line
   * must not go on contradicting it.
   */
  it("states the no-flow bucket's criterion, not a conclusion about what those loops are", async () => {
    const lines: string[] = [];
    const code = await run(["overview", workDir, "--repo-root", workDir], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("个不在任何链路里");
    expect(out).not.toContain("background");
  });

  it("honors --out and labels a no-repo-root run as structural", async () => {
    const outPath = join(workDir, "map.html");
    const lines: string[] = [];
    const code = await run(["overview", workDir, "--out", outPath], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("structural");
    const html = await readFile(outPath, "utf8");
    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const p = JSON.parse((m?.[1] ?? "{}").replace(/\\u003c/g, "<"));
    expect(p.meta.repoResolved).toBe(false);
  });

  it("skips loudly when the model dir is missing, still exits 0", async () => {
    const empty = await mkdtemp(join(tmpdir(), "codeontic-overview-empty-"));
    try {
      const lines: string[] = [];
      const code = await run(["overview", empty], {
        log: (m) => lines.push(m),
        error: (m) => lines.push(m),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("⚠ overview skipped:");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

/**
 * The panorama (§ views/overview-html.ts, `computeArchitecture`). Geometry is
 * asserted only where it carries meaning — grouping, edges, ordering — never
 * pixel values, which would make every visual tweak a test edit.
 */
describe("computeArchitecture — the panorama", () => {
  const build = (entries: Parameters<typeof buildGraph>[0]) => {
    const { graph } = buildGraph(entries);
    return computeArchitecture(computeOverviewModel(graph, computeConformance(graph, {})));
  };

  it("normalizes an owner down to its base package", () => {
    expect(moduleKeyOf("packages/a (仅退役窗口)")).toBe("packages/a");
    expect(moduleKeyOf("packages/a (X 触发), packages/b (Y 生成)")).toBe("packages/a");
    expect(moduleKeyOf(null)).toBe("");
  });

  it("groups every node into its module box and strips the shared path prefix", () => {
    const a = build([
      { file: "a", node: loop({ id: "L1", owner: "packages/alpha" }) },
      { file: "b", node: loop({ id: "L2", owner: "packages/alpha (子系统)" }) },
      { file: "c", node: loop({ id: "L3", owner: "packages/beta" }) },
    ]);
    expect(a.prefix).toBe("packages/");
    expect(a.modules.map((m) => m.label)).toEqual(["alpha", "beta"]);
    // the full key survives for the tooltip; only the label is shortened
    expect(a.modules[0]?.key).toBe("packages/alpha");
    expect(a.modules[0]?.loops).toBe(2);
    expect(a.nodes.map((n) => n.id).sort()).toEqual(["L1", "L2", "L3"]);
  });

  /**
   * A flow carries no owner, so a package that holds only entrances would be
   * invisible without the anchor-path fallback — pi has two such packages
   * (client, evals) and they were missing from the first cut of this picture.
   */
  it("places a flow by its own anchor path, so a flows-only package still gets a box", () => {
    const a = build([
      { file: "a", node: loop({ id: "L1", owner: "packages/alpha" }) },
      { file: "b", node: flow({ id: "C1", anchors: ["packages/client/src/x.ts#f"] }) },
    ]);
    expect(a.modules.map((m) => m.label).sort()).toEqual(["alpha", "client"]);
    const c1 = a.nodes.find((n) => n.id === "C1");
    expect(c1?.kind).toBe("flow");
  });

  it("falls back to the loops it traverses when a composed flow has no anchors", () => {
    const a = build([
      { file: "a", node: loop({ id: "L1", owner: "packages/alpha" }) },
      { file: "b", node: flow({ id: "C1", traverses: ["L1"] }) },
    ]);
    expect(a.modules).toHaveLength(1);
    expect(a.modules[0]?.flows).toBe(1);
    // and the hover link is recorded, which is how the picture shows a journey
    expect(a.nodes.find((n) => n.id === "C1")?.links).toEqual(["L1"]);
  });

  it("draws one edge per junction however many nodes carry it, and marks the cross-module one", () => {
    const a = build([
      { file: "a", node: loop({ id: "L1", owner: "packages/alpha" }) },
      { file: "b", node: loop({ id: "L2", owner: "packages/alpha" }) },
      { file: "c", node: loop({ id: "L3", owner: "packages/beta" }) },
      { file: "d", node: junction({ id: "J-in", between: ["L1", "L2"] }) },
      { file: "e", node: junction({ id: "J-out", between: ["L2", "L3"] }) },
    ]);
    // both endpoints carry each junction; it must still be ONE line each
    expect(a.edges.map((e) => e.id)).toEqual(["J-in", "J-out"]);
    expect(a.edges.find((e) => e.id === "J-in")?.cross).toBe(false);
    expect(a.edges.find((e) => e.id === "J-out")?.cross).toBe(true);
    expect(a.droppedEdges).toBe(0);
  });

  it("counts a junction pointing at a node that isn't on the map rather than dropping it silently", () => {
    const a = build([
      { file: "a", node: loop({ id: "L1" }) },
      { file: "b", node: junction({ id: "J-dangling", between: ["L1", "GHOST"] }) },
    ]);
    expect(a.edges).toHaveLength(0);
    expect(a.droppedEdges).toBe(1);
  });

  it("orders coupled modules next to each other", () => {
    // `big` is largest so it anchors the row; `far` is bigger than `near` but
    // `near` is coupled to `big`, so affinity must pull it in first.
    const a = build([
      { file: "a", node: loop({ id: "L1", owner: "packages/big" }) },
      { file: "b", node: loop({ id: "L2", owner: "packages/big" }) },
      { file: "c", node: loop({ id: "L3", owner: "packages/big" }) },
      { file: "d", node: loop({ id: "L4", owner: "packages/far" }) },
      { file: "e", node: loop({ id: "L5", owner: "packages/far" }) },
      { file: "f", node: loop({ id: "L6", owner: "packages/near" }) },
      { file: "g", node: junction({ id: "J", between: ["L1", "L6"] }) },
    ]);
    expect(a.modules.map((m) => m.label)).toEqual(["big", "near", "far"]);
  });

  it("keeps unplaceable nodes in a bucket of their own, always last", () => {
    const a = build([
      { file: "a", node: loop({ id: "L1", owner: "packages/alpha" }) },
      { file: "b", node: flow({ id: "C1" }) },
    ]);
    expect(a.modules.map((m) => m.label)).toEqual(["packages/alpha", "（未归属）"]);
    // a single real module means no shared prefix to strip
    expect(a.prefix).toBe("");
  });

  it("is deterministic — same model in, identical geometry out", () => {
    const entries: Parameters<typeof buildGraph>[0] = [
      { file: "a", node: loop({ id: "L1", owner: "packages/alpha" }) },
      { file: "b", node: loop({ id: "L2", owner: "packages/beta" }) },
      { file: "c", node: junction({ id: "J", between: ["L1", "L2"] }) },
    ];
    expect(JSON.stringify(build(entries))).toBe(JSON.stringify(build(entries)));
  });
});

describe("renderOverviewHtml — page order and the new sections", () => {
  function sample() {
    const { graph } = buildGraph([
      { file: "a", node: flow({ id: "C1", traverses: ["L1"] }) },
      { file: "b", node: loop({ id: "L1", anchors: ["src/a.ts#A"], scenarios: ["GWT-1"] }) },
      { file: "c", node: loop({ id: "L2", owner: "packages/other", consumes_queues: ["jobs"] }) },
      { file: "d", node: junction({ id: "J", between: ["L1", "L2"] }) },
      { file: "e", node: scenario({ id: "GWT-1" }) },
      { file: "f", node: debt({ id: "DEBT-1", subject: "x".repeat(400) }) },
    ]);
    return computeOverviewModel(graph, computeConformance(graph, {}));
  }

  /**
   * Whole first, parts second, receipts last. The ledger used to open the page
   * and, on a real model, buried the map under 500-character debt prose.
   */
  it("opens with the panorama and closes with the ledger", () => {
    const html = renderOverviewHtml(sample(), META);
    const arch = html.indexOf('id="archHead"');
    const flows = html.indexOf('id="flowsHead"');
    const detail = html.indexOf('id="detailHead"');
    const ledger = html.indexOf('id="findHead"');
    expect(arch).toBeGreaterThan(-1);
    expect(arch).toBeLessThan(flows);
    expect(flows).toBeLessThan(detail);
    expect(detail).toBeLessThan(ledger);
    expect(html).toContain("① 系统全景");
    expect(html).toContain("⑤ 欠账");
  });

  it("ships the panorama geometry in the island and renders it as inline SVG", () => {
    const html = renderOverviewHtml(sample(), META);
    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const p = JSON.parse((m?.[1] ?? "").replace(/\\u003c/g, "<"));
    expect(p.arch.modules.length).toBeGreaterThan(0);
    expect(p.arch.nodes.length).toBe(3);
    expect(html).toContain('<svg class="arch"');
    // entrance vs loop is a SHAPE difference, and hovering an entrance lights
    // the loops it walks
    expect(html).toContain('rx="'); // node corner radius is kind-dependent
    expect(html).toContain(".an[data-hl]");
  });

  it("gives junctions, scenario coverage and queues a place of their own", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain("④ 建模细节");
    expect(html).toContain("交接点 · ");
    expect(html).toContain("场景与测试覆盖");
    expect(html).toContain("一个场景都没有的节点");
    expect(html).toContain("队列与消费关系");
    // the honesty line the engine's whole contract rests on
    expect(html).toContain("它不判断这个测试是否真的测到了场景说的事");
  });

  it("clamps a long debt body behind an expander that states its real length", () => {
    const html = renderOverviewHtml(sample(), META);
    expect(html).toContain('<span class="clamp">');
    expect(html).toContain("展开全文（");
    expect(html).toContain('data-shut="收起"');
  });
});

/**
 * Two defects a review pass surfaced on the first cut of the panorama. Both
 * are the same failure mode — the page stating something in words that its own
 * data does not support — which is the one thing this whole engine exists to
 * prevent, so each gets a test of its own.
 */
describe("panorama + coverage — statements the page must be able to back", () => {
  it("does not call a legal ONE-SIDED junction a dangling reference", () => {
    // `Junction.between` is `.min(1)` — a one-sided junction is a valid model.
    // It has no segment to draw, but the page used to count it as "its id does
    // not exist in the model", which is simply false.
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      { file: "b", node: junction({ id: "J-solo", between: ["L1"] }) },
    ]);
    const a = computeArchitecture(computeOverviewModel(graph, computeConformance(graph, {})));
    expect(a.edges).toHaveLength(0);
    expect(a.droppedEdges).toBe(0);
  });

  it("still reports a MULTI-sided junction whose other endpoint is missing", () => {
    const { graph } = buildGraph([
      { file: "a", node: loop({ id: "L1" }) },
      { file: "b", node: junction({ id: "J-half", between: ["L1", "GHOST"] }) },
    ]);
    const a = computeArchitecture(computeOverviewModel(graph, computeConformance(graph, {})));
    expect(a.droppedEdges).toBe(1);
  });

  it("keeps a dead test binding out of the bound-to-a-real-test count", () => {
    const html = renderOverviewHtml(
      computeOverviewModel(
        buildGraph([{ file: "a", node: loop({ id: "L1" }) }]).graph,
        computeConformance(buildGraph([{ file: "a", node: loop({ id: "L1" }) }]).graph, {}),
      ),
      META,
    );
    // a scenario whose test file resolved to `ok:false` is counted as broken,
    // never as tested — otherwise the dead binding sits inside the greenest
    // number on the card
    expect(html).toContain("if(bad) scn.broken++; else scn.tested++;");
    expect(html).toContain("绑到了真实存在的测试");
    expect(html).toContain("绑了测试、文件已不在");
  });

  it("states the scope of the scenario tally instead of implying it covers the model", () => {
    const html = renderOverviewHtml(
      computeOverviewModel(
        buildGraph([{ file: "a", node: loop({ id: "L1" }) }]).graph,
        computeConformance(buildGraph([{ file: "a", node: loop({ id: "L1" }) }]).graph, {}),
      ),
      META,
    );
    // junctions carry scenarios too and are NOT in this tally; say so
    expect(html).toContain("交接点也能带场景，这里没有计入");
    expect(html).toContain("（loop 和链路上的）");
  });
});
