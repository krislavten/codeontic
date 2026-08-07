import { describe, expect, it } from "vitest";
import type { ImplementationFact } from "../src/adapters/types.js";
import type { ModelGraph } from "../src/loader/model-graph.js";
import { checkLoopMechanism } from "../src/validate/mechanism.js";

function loopGraph(
  loops: Array<{
    id: string;
    anchors?: string[];
    mechanism?: Array<"poller" | "queue">;
    dormant?: boolean;
  }>,
): ModelGraph {
  const map = new Map<string, unknown>();
  for (const l of loops)
    map.set(l.id, {
      id: l.id,
      kind: "loop",
      title: l.id,
      boundary: "b",
      owner: "o",
      anchors: l.anchors ?? [],
      consumes_queues: [],
      scenarios: [],
      status: "unverified",
      ...(l.mechanism ? { mechanism: l.mechanism } : {}),
      ...(l.dormant ? { dormant: true } : {}),
    });
  return {
    byKind: {
      feature: new Map(),
      flow: new Map(),
      loop: map,
      junction: new Map(),
      scenario: new Map(),
    },
  } as unknown as ModelGraph;
}

const poller = (filePath: string): ImplementationFact => ({
  signal: "setinterval_poller" as ImplementationFact["signal"],
  name: `setInterval@${filePath}:1`,
  filePath,
  line: 1,
});

const noFiles = () => null;

describe("checkLoopMechanism", () => {
  it("says nothing about loops that never declared a mechanism — opt-in is the whole design", () => {
    const graph = loopGraph([{ id: "L1", anchors: ["a/facade.ts#start"] }]);
    expect(checkLoopMechanism(graph, [], { readFile: noFiles })).toEqual([]);
  });

  it("passes when the declared timer is right there in the anchored file", () => {
    const graph = loopGraph([{ id: "L1", anchors: ["a/service.ts#start"], mechanism: ["poller"] }]);
    const v = checkLoopMechanism(graph, [poller("a/service.ts")], { readFile: noFiles });
    expect(v).toEqual([]);
  });

  it("warns when a declared timer is nowhere in the anchored files — the case this exists for", () => {
    const graph = loopGraph([{ id: "L1", anchors: ["a/facade.ts#start"], mechanism: ["poller"] }]);
    const v = checkLoopMechanism(graph, [poller("a/elsewhere.ts")], { readFile: noFiles });
    expect(v).toHaveLength(1);
    expect(v[0]?.check).toBe("loop-mechanism");
    expect(v[0]?.severity).toBe("warning"); // advisory, never a gate
    expect(v[0]?.message).toContain("a/facade.ts");
  });

  it("follows one delegation hop before complaining, and says so with an info finding (not a warning)", () => {
    const facade = `
      import { Impl } from "./impl.js";
      export class S {
        constructor(private impl: Impl) {}
        start() { return this.impl.start(); }
      }`;
    const graph = loopGraph([{ id: "L1", anchors: ["a/facade.ts#start"], mechanism: ["poller"] }]);
    // 1 blank · 2 class · 3 start() { · 4 setInterval · 5 } · 6 }
    const impl = [
      "",
      "export class Impl {",
      "  start() {",
      "    return setInterval(tick, 1000);",
      "  }",
      "}",
    ].join("\n");
    const files: Record<string, string> = { "a/facade.ts": facade, "a/impl.ts": impl };
    const v = checkLoopMechanism(graph, [{ ...poller("a/impl.ts"), line: 4 }], {
      readFile: (p) => files[p] ?? null,
    });
    // A surviving wrapper is not a defect — but it also isn't SILENCE: an
    // empty array here would be indistinguishable from the check never
    // having run at all, so a hit is reported as a "severity: info" finding
    // (never fails anything — see types.ts) rather than folded into `[]`.
    expect(v).toHaveLength(1);
    expect(v[0]?.check).toBe("loop-mechanism");
    expect(v[0]?.severity).toBe("info");
    expect(v[0]?.nodeId).toBe("L1");
    expect(v[0]?.message).toContain("verified via delegation");
    expect(v[0]?.message).toContain("a/facade.ts#start → a/impl.ts#start");
  });

  it("--no-follow-delegation (followDelegation: false) turns the same case back into a warning", () => {
    // Identical fixture to the test above — only `followDelegation` differs —
    // so this is the "two-sided" check the CLI flag exists for: flip
    // delegation off and the info finding must revert to the failure it was
    // hiding, not just disappear.
    const facade = `
      import { Impl } from "./impl.js";
      export class S {
        constructor(private impl: Impl) {}
        start() { return this.impl.start(); }
      }`;
    const impl = [
      "",
      "export class Impl {",
      "  start() {",
      "    return setInterval(tick, 1000);",
      "  }",
      "}",
    ].join("\n");
    const graph = loopGraph([{ id: "L1", anchors: ["a/facade.ts#start"], mechanism: ["poller"] }]);
    const files: Record<string, string> = { "a/facade.ts": facade, "a/impl.ts": impl };
    const v = checkLoopMechanism(graph, [{ ...poller("a/impl.ts"), line: 4 }], {
      readFile: (p) => files[p] ?? null,
      followDelegation: false,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    // Positive assertion, not just the absence of "followed delegation": this
    // is the SAME failure message `checkLoopMechanism` produces when there
    // was never any delegation to follow in the first place (a/impl.ts is
    // never even looked at), which is the actual claim "turns back into a
    // warning" is making.
    expect(v[0]?.message).toContain('no "poller" fact was found in its anchor file(s)');
    expect(v[0]?.message).toContain("found: no facts at all");
    expect(v[0]?.message).not.toContain("followed delegation");
  });

  it("rejects a hop that lands in the right file but the wrong method — evidence must be the delegated one", () => {
    // The far side has a timer, just not in the method the wrapper hands off to.
    // A file-level hop would call this verified; that is the same false green,
    // moved one hop out.
    const facade = `
      import { Impl } from "./impl.js";
      export class S {
        constructor(private impl: Impl) {}
        start() { return this.impl.start(); }
      }`;
    // 1 blank · 2 class · 3-5 start() (no timer) · 6-8 somethingElse() (has the timer)
    const impl = [
      "",
      "export class Impl {",
      "  start() {",
      "    return this.noop();",
      "  }",
      "  somethingElse() {",
      "    return setInterval(tick, 1000);",
      "  }",
      "}",
    ].join("\n");
    const graph = loopGraph([{ id: "L1", anchors: ["a/facade.ts#start"], mechanism: ["poller"] }]);
    const files: Record<string, string> = { "a/facade.ts": facade, "a/impl.ts": impl };
    const v = checkLoopMechanism(graph, [{ ...poller("a/impl.ts"), line: 7 }], {
      readFile: (p) => files[p] ?? null,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("followed delegation");
  });

  it("still warns through a wrapper when the far side has no timer either", () => {
    const facade = `
      import { Impl } from "./impl.js";
      export class S {
        constructor(private impl: Impl) {}
        start() { return this.impl.start(); }
      }`;
    const graph = loopGraph([{ id: "L1", anchors: ["a/facade.ts#start"], mechanism: ["poller"] }]);
    const files: Record<string, string> = { "a/facade.ts": facade, "a/impl.ts": "// nothing" };
    const v = checkLoopMechanism(graph, [poller("a/unrelated.ts")], {
      readFile: (p) => files[p] ?? null,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("followed delegation");
  });

  it("keeps the direct hit file-level on purpose — an anchored class counts for a timer in any of its methods", () => {
    // Boundary lock, not an oversight. An anchor's symbol is routinely a class or a
    // const while the timer lives in a method or a call site further down the file;
    // demanding the fact sit inside the anchored symbol's own span would turn those
    // into false reds. The delegation hop is held to the stricter rule because there
    // the landing spot is the tool's own inference, not the author's statement.
    const graph = loopGraph([
      { id: "L1", anchors: ["a/service.ts#SomeService"], mechanism: ["poller"] },
    ]);
    const v = checkLoopMechanism(graph, [{ ...poller("a/service.ts"), line: 900 }], {
      readFile: noFiles,
    });
    expect(v).toEqual([]);
  });

  it("matches an adapter's own vocabulary by word — `pg_boss_queue` satisfies `queue`", () => {
    const graph = loopGraph([{ id: "L1", anchors: ["a/p.ts#send"], mechanism: ["queue"] }]);
    const fact: ImplementationFact = {
      signal: "pg_boss_queue" as ImplementationFact["signal"],
      name: "run:execute",
      filePath: "a/p.ts",
      line: 3,
    };
    expect(checkLoopMechanism(graph, [fact], { readFile: noFiles })).toEqual([]);
  });

  it("flags a mechanism claim on a loop with no anchors — nothing could verify it", () => {
    const graph = loopGraph([{ id: "L1", mechanism: ["poller"] }]);
    const v = checkLoopMechanism(graph, [], { readFile: noFiles });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("no anchors");
  });

  it("skips dormant loops — a baseline registration claims nothing", () => {
    const graph = loopGraph([
      { id: "L1", anchors: ["a/x.ts#s"], mechanism: ["poller"], dormant: true },
    ]);
    expect(checkLoopMechanism(graph, [], { readFile: noFiles })).toEqual([]);
  });
});
