import { describe, expect, it } from "vitest";
import type { ImplementationFact } from "../src/adapters/types.js";
import { createEmptyGraph } from "../src/loader/model-graph.js";
import { Junction, Loop } from "../src/schema/model.js";
import { anchorFile, coveredFiles, reconcileFacts } from "../src/validate/unregistered.js";

const queueFact = (name: string, filePath: string, line = 1): ImplementationFact => ({
  signal: "pg_boss_queue",
  name,
  filePath,
  line,
});

/** A graph carrying one loop (with anchors) and one junction (with evidence anchors). */
function graphWith(loopAnchors: string[], junctionEvidenceAnchors: string[]) {
  const graph = createEmptyGraph();
  graph.byKind.loop.set(
    "L1",
    Loop.parse({
      id: "L1",
      kind: "loop",
      title: "t",
      boundary: "b",
      owner: "o",
      anchors: loopAnchors,
    }),
  );
  graph.byKind.junction.set(
    "J-x",
    Junction.parse({
      id: "J-x",
      kind: "junction",
      risk_class: "idempotency",
      between: ["L1"],
      evidence: junctionEvidenceAnchors.map((anchor, i) => ({
        id: `E-${i}`,
        kind: "code",
        anchor,
      })),
    }),
  );
  return graph;
}

describe("C2 unregistered-fact reconciliation (Proposal 006)", () => {
  it("anchorFile takes the file part before `#` (or the whole string)", () => {
    expect(anchorFile("apps/w/src/x.ts#Sym")).toBe("apps/w/src/x.ts");
    expect(anchorFile("apps/w/src/x.ts")).toBe("apps/w/src/x.ts");
    expect(anchorFile("specs/features/y.md#Heading")).toBe("specs/features/y.md");
  });

  it("coveredFiles unions loop anchors and junction evidence anchors (file parts only)", () => {
    const covered = coveredFiles(graphWith(["a/loop.ts#L"], ["b/evi.ts#E", "specs/z.md#H"]));
    expect([...covered].sort()).toEqual(["a/loop.ts", "b/evi.ts", "specs/z.md"]);
  });

  it("splits facts into registered (file covered) vs unregistered", () => {
    const graph = graphWith(["apps/w/covered.ts#L"], []);
    const facts = [queueFact("q1", "apps/w/covered.ts"), queueFact("q2", "apps/w/orphan.ts")];
    const { registered, unregistered } = reconcileFacts(facts, graph);
    expect(registered.map((f) => f.name)).toEqual(["q1"]);
    expect(unregistered.map((f) => f.name)).toEqual(["q2"]);
  });

  it("is FILE-LEVEL: any anchor in a file covers every fact in that file (deliberate under-flag)", () => {
    const graph = graphWith(["apps/w/multi.ts#OnlyOneLoop"], []);
    // two distinct queues in the same file — the second is NOT separately modeled,
    // but file-level coverage treats both as registered (bias to silence, not noise).
    const facts = [queueFact("modeled", "apps/w/multi.ts"), queueFact("extra", "apps/w/multi.ts")];
    const { unregistered } = reconcileFacts(facts, graph);
    expect(unregistered).toEqual([]);
  });

  it("a fact covered ONLY by a dormant N-loop is registered but reported as dormant-suppressed", () => {
    const graph = createEmptyGraph();
    graph.byKind.loop.set(
      "N19",
      Loop.parse({
        id: "N19",
        kind: "loop",
        title: "ttl renewal (baseline-only N-loop)",
        boundary: "b",
        owner: null,
        dormant: true,
        anchors: ["apps/w/ttl.ts#TtlWorker"],
      }),
    );
    graph.byKind.loop.set(
      "L1",
      Loop.parse({
        id: "L1",
        kind: "loop",
        title: "active",
        boundary: "b",
        owner: "o",
        anchors: ["apps/w/core.ts#Core"],
      }),
    );
    const facts = [
      queueFact("ttl_renewal", "apps/w/ttl.ts"),
      queueFact("run:execute", "apps/w/core.ts"),
    ];
    const { registered, dormantSuppressed, unregistered } = reconcileFacts(facts, graph);
    // disjoint buckets: the dormant-covered fact is NOT in `registered`.
    expect(registered.map((f) => f.name)).toEqual(["run:execute"]);
    expect(dormantSuppressed.map((f) => f.name)).toEqual(["ttl_renewal"]); // quieted but surfaced
    expect(unregistered).toEqual([]);
    expect(registered.length + dormantSuppressed.length + unregistered.length).toBe(facts.length);
  });

  it("a file covered by BOTH an active and a dormant loop counts as active (not dormant-suppressed)", () => {
    const graph = createEmptyGraph();
    graph.byKind.loop.set(
      "L1",
      Loop.parse({
        id: "L1",
        kind: "loop",
        title: "active",
        boundary: "b",
        owner: "o",
        anchors: ["apps/w/x.ts#A"],
      }),
    );
    graph.byKind.loop.set(
      "N1",
      Loop.parse({
        id: "N1",
        kind: "loop",
        title: "dormant",
        boundary: "b",
        owner: null,
        dormant: true,
        anchors: ["apps/w/x.ts#B"],
      }),
    );
    const { registered, dormantSuppressed } = reconcileFacts(
      [queueFact("q", "apps/w/x.ts")],
      graph,
    );
    expect(registered).toHaveLength(1);
    expect(dormantSuppressed).toEqual([]); // active coverage wins — not counted as suppressed
  });

  it("registers a queue fact by NAME via consumes_queues, even when its file is unanchored", () => {
    const graph = createEmptyGraph();
    // L2 consumes run:execute but is anchored to the state-machine file, NOT the
    // producer registry (services.ts) where the queue name is defined.
    graph.byKind.loop.set(
      "L2",
      Loop.parse({
        id: "L2",
        kind: "loop",
        title: "Run",
        boundary: "b",
        owner: "o",
        anchors: ["packages/control-plane/src/run/run-service.ts#RunService"],
        consumes_queues: ["run:execute"],
      }),
    );
    const facts = [
      queueFact("run:execute", "apps/agent-hub/lib/services.ts"), // producer registry, no anchor
      queueFact("other:queue", "apps/agent-hub/lib/services.ts"), // not consumed by any loop
    ];
    const { registered, unregistered } = reconcileFacts(facts, graph, ["pg_boss_queue"]);
    expect(registered.map((f) => f.name)).toEqual(["run:execute"]); // name-matched
    expect(unregistered.map((f) => f.name)).toEqual(["other:queue"]);
  });

  it("flags a consumes_queues declaration that matches no extracted fact, with its declarer", () => {
    const graph = createEmptyGraph();
    graph.byKind.loop.set(
      "L2",
      Loop.parse({
        id: "L2",
        kind: "loop",
        title: "Run",
        boundary: "b",
        owner: "o",
        consumes_queues: ["run:execute", "run:excute"], // second is a typo
      }),
    );
    const { unmatchedConsumedQueues } = reconcileFacts(
      [queueFact("run:execute", "svc.ts")],
      graph,
      ["pg_boss_queue"],
    );
    // Surfaced, not silent — and carrying WHO declared it. An unmatched name is
    // ambiguous between "the model is wrong" and "extraction never reached the
    // code", so the report has to hand over the thread to pull (the declaring
    // loop, hence its anchors) instead of just naming the queue.
    expect(unmatchedConsumedQueues).toEqual([{ queue: "run:excute", declaredBy: ["L2"] }]);
  });

  it("attributes an unmatched queue to EVERY active loop that declared it", () => {
    const graph = createEmptyGraph();
    for (const id of ["L9", "L3"]) {
      graph.byKind.loop.set(
        id,
        Loop.parse({
          id,
          kind: "loop",
          title: id,
          boundary: "b",
          owner: "o",
          consumes_queues: ["shared:gone"],
        }),
      );
    }
    const { unmatchedConsumedQueues } = reconcileFacts([], graph, ["pg_boss_queue"]);
    // Sorted, so the report is stable across model-load order.
    expect(unmatchedConsumedQueues).toEqual([{ queue: "shared:gone", declaredBy: ["L3", "L9"] }]);
  });

  it("consumes_queues only matches pg_boss_queue facts, not pollers (name is a queue string)", () => {
    const graph = createEmptyGraph();
    graph.byKind.loop.set(
      "L1",
      Loop.parse({
        id: "L1",
        kind: "loop",
        title: "t",
        boundary: "b",
        owner: "o",
        consumes_queues: ["a:poller"],
      }),
    );
    // a poller whose synthetic name happens to collide must NOT be name-registered
    const poller: ImplementationFact = {
      signal: "setinterval_poller",
      name: "a:poller",
      filePath: "x.ts",
      line: 1,
    };
    const { unregistered } = reconcileFacts([poller], graph, ["pg_boss_queue"]);
    expect(unregistered).toHaveLength(1); // pollers reconcile by file only, even with name-match enabled
  });

  it("a dormant loop's consumes_queues does NOT register (suppression channel is only anchors)", () => {
    const graph = createEmptyGraph();
    graph.byKind.loop.set(
      "N9",
      Loop.parse({
        id: "N9",
        kind: "loop",
        title: "t",
        boundary: "b",
        owner: null,
        dormant: true,
        consumes_queues: ["q:1"],
      }),
    );
    const { registered, unregistered } = reconcileFacts([queueFact("q:1", "x.ts")], graph, [
      "pg_boss_queue",
    ]);
    expect(registered).toEqual([]); // dormant consumes_queues is inert — only anchors suppress
    expect(unregistered.map((f) => f.name)).toEqual(["q:1"]);
  });

  it("empty facts reconcile to empty; coveredFiles is still reported", () => {
    const graph = graphWith(["a/x.ts#L"], []);
    const r = reconcileFacts([], graph);
    expect(r.registered).toEqual([]);
    expect(r.unregistered).toEqual([]);
    expect(r.coveredFiles).toEqual(["a/x.ts"]);
  });
});

describe("reconcileFacts — one-hop delegation into registered (#23 PR3)", () => {
  // Same shape mechanism.test.ts uses for its own delegation cases: a facade
  // that hands `start()` off to `Impl#start`, which really has the timer —
  // plus a second, unrelated method `other()` so the "right file, wrong
  // symbol" negative case has something real to land in.
  const facade = `
    import { Impl } from "./impl.js";
    export class S {
      constructor(private impl: Impl) {}
      start() { return this.impl.start(); }
    }`;
  // 1 blank · 2 class · 3-5 start() (has the timer) · 6-8 other() (unrelated)
  const impl = [
    "",
    "export class Impl {",
    "  start() {",
    "    return setInterval(tick, 1000);",
    "  }",
    "  other() {",
    "    return doSomething();",
    "  }",
    "}",
  ].join("\n");
  const files: Record<string, string> = { "a/facade.ts": facade, "a/impl.ts": impl };
  const readFile = (p: string) => files[p] ?? null;

  /** A graph with one loop anchored to the facade's `start` — active by default, dormant on request. */
  function graphWithDelegatingLoop(dormant = false) {
    const graph = createEmptyGraph();
    graph.byKind.loop.set(
      "L1",
      Loop.parse({
        id: "L1",
        kind: "loop",
        title: "t",
        boundary: "b",
        owner: dormant ? null : "o",
        anchors: ["a/facade.ts#start"],
        ...(dormant ? { dormant: true } : {}),
      }),
    );
    return graph;
  }

  it("registers a fact that lands inside the delegation target's own symbol span", () => {
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("timer", "a/impl.ts", 4)]; // inside start()'s span [3,5]
    const { registered, unregistered } = reconcileFacts(facts, graph, [], { readFile });
    expect(registered.map((f) => f.name)).toEqual(["timer"]);
    expect(unregistered).toEqual([]);
  });

  it("does NOT register a fact in the delegation target's FILE but a DIFFERENT symbol — the collapsed-granularity core negative", () => {
    // This is the case file-level credit would have gotten wrong: landing in
    // the right file is not evidence, only landing in the delegated method's
    // own span is (delegation.ts's `symbolLineSpan` doc).
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("other-timer", "a/impl.ts", 7)]; // inside other()'s span [6,8], not start()'s
    const { registered, unregistered, delegationHits } = reconcileFacts(facts, graph, [], {
      readFile,
    });
    expect(registered).toEqual([]);
    expect(unregistered.map((f) => f.name)).toEqual(["other-timer"]);
    // The hop DID resolve (a/facade.ts really does delegate to a/impl.ts#start)
    // — it just didn't collect this particular fact, because "other-timer"
    // sits outside start()'s span. registeredFactCount: 0 here is the
    // meaningful case (a real fact present, just not matching), unlike the
    // "no facts at all" test below.
    expect(delegationHits).toEqual([
      {
        loopId: "L1",
        anchor: "a/facade.ts#start",
        target: "a/impl.ts#start",
        registeredFactCount: 0,
      },
    ]);
  });

  it("followDelegation: false reverts the in-span fact back to unregistered — the two-sided check", () => {
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("timer", "a/impl.ts", 4)];
    const { registered, unregistered, delegationHits } = reconcileFacts(facts, graph, [], {
      readFile,
      followDelegation: false,
    });
    expect(registered).toEqual([]);
    expect(unregistered.map((f) => f.name)).toEqual(["timer"]);
    expect(delegationHits).toEqual([]);
  });

  it("omitting the 4th argument (delegationOptions) skips delegation, even for a fact that WOULD have registered with it", () => {
    // Not a before/after regression run (this test file didn't exist pre-change)
    // — what it actually proves is that the new 4th param defaults to
    // "delegation off", so every pre-existing call site in this file (which all
    // call with ≤3 args) keeps reconciling by file-level anchors only.
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("timer", "a/impl.ts", 4)];
    const { registered, unregistered, delegationHits } = reconcileFacts(facts, graph); // no 4th arg at all
    expect(registered).toEqual([]);
    expect(unregistered.map((f) => f.name)).toEqual(["timer"]);
    expect(delegationHits).toEqual([]);
  });

  it("a dormant loop's delegation target grants no registration — the suppression channel is only its OWN anchor", () => {
    const graph = graphWithDelegatingLoop(true);
    const facts = [queueFact("timer", "a/impl.ts", 4)];
    const { registered, dormantSuppressed, unregistered, delegationHits } = reconcileFacts(
      facts,
      graph,
      [],
      { readFile },
    );
    expect(registered).toEqual([]);
    // a/impl.ts itself carries no anchor of its own (dormant or otherwise) —
    // only a/facade.ts does — so this is plain unregistered, not suppressed.
    expect(dormantSuppressed).toEqual([]);
    expect(unregistered.map((f) => f.name)).toEqual(["timer"]);
    expect(delegationHits).toEqual([]); // dormant loops are excluded before resolution even starts
  });

  /**
   * THE METRIC-CONTAMINATION GUARD. `coveredFiles` is what the 判据 A backtest
   * (#23 PR1) measures "does the model have anything to say about the files
   * people actually change" against. If following a delegation widened THAT
   * set, this PR would silently raise the coverage number it is measured by —
   * a change grading its own homework, and precisely the gaming 判据 C exists
   * to catch. Registration widens; the covered-file set does not.
   */
  it("does NOT widen coveredFiles — delegation registers facts, it never enlarges the measured anchor set", () => {
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("timer", "a/impl.ts", 4)];
    // Baseline BEFORE anything runs, so a mutation of `graph` by the calls
    // below is caught by comparison rather than by re-deriving from a graph
    // that may already have been changed.
    const beforeAnyCall = [...coveredFiles(graph)];
    expect(beforeAnyCall).toEqual(["a/facade.ts"]);

    const withDelegation = reconcileFacts(facts, graph, [], { readFile });
    const withoutDelegation = reconcileFacts(facts, graph, [], {
      readFile,
      followDelegation: false,
    });

    // The fact's registration DID change — that is the feature working...
    expect(withDelegation.registered).toHaveLength(1);
    expect(withoutDelegation.registered).toHaveLength(0);

    // ...while the measured covered-file set did not move. BOTH sides are
    // pinned to the literal, not merely to each other: an equality-only
    // assertion would still pass if a regression emptied both, which is
    // exactly the shape of failure this guard has to survive.
    expect(withoutDelegation.coveredFiles).toEqual(["a/facade.ts"]);
    expect(withDelegation.coveredFiles).toEqual(["a/facade.ts"]);
    expect(withDelegation.coveredFiles).not.toContain("a/impl.ts");

    // And the standalone export the backtest reads is unchanged by having RUN
    // the delegation path — not just unchanged as a property of the graph.
    expect([...coveredFiles(graph)]).toEqual(beforeAnyCall);
  });

  it("reports the delegation hit with its resolved target and how many facts it registered", () => {
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("timer", "a/impl.ts", 4), queueFact("timer2", "a/impl.ts", 4)];
    const { delegationHits } = reconcileFacts(facts, graph, [], { readFile });
    expect(delegationHits).toEqual([
      {
        loopId: "L1",
        anchor: "a/facade.ts#start",
        target: "a/impl.ts#start",
        registeredFactCount: 2,
      },
    ]);
  });

  it("reports a resolved hop even with an EMPTY facts array — resolution never depends on facts existing", () => {
    // Distinct from the registeredFactCount: 0 case two tests up (a real fact
    // that just missed the span): this is "no facts were even extracted", to
    // confirm delegation resolution runs off the MODEL (loop anchors), not
    // off the fact list — it would be a bug if an empty facts array silently
    // suppressed the hop report too.
    const graph = graphWithDelegatingLoop();
    const { delegationHits } = reconcileFacts([], graph, [], { readFile });
    expect(delegationHits).toEqual([
      {
        loopId: "L1",
        anchor: "a/facade.ts#start",
        target: "a/impl.ts#start",
        registeredFactCount: 0,
      },
    ]);
  });

  it("keeps the three buckets disjoint and complete with delegation in play", () => {
    const graph = graphWithDelegatingLoop();
    const facts = [queueFact("in-span", "a/impl.ts", 4), queueFact("out-of-span", "a/impl.ts", 7)];
    const r = reconcileFacts(facts, graph, [], { readFile });
    expect(r.registered.length + r.dormantSuppressed.length + r.unregistered.length).toBe(
      facts.length,
    );
    expect(r.registered.map((f) => f.name)).toEqual(["in-span"]);
    expect(r.unregistered.map((f) => f.name)).toEqual(["out-of-span"]);
  });
});
