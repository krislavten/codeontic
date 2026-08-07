import { describe, expect, it } from "vitest";
import {
  DebtEntry,
  EVIDENCE_NOTE_MAX,
  Evidence,
  Flow,
  Junction,
  Loop,
  ModelNode,
  Scenario,
} from "../src/schema/index.js";

describe("Loop schema — gnarly cases from a real-world target repo", () => {
  it("parses an ordinary top-level loop (L1)", () => {
    const loop = Loop.parse({
      id: "L1",
      kind: "loop",
      title: "Session Startup 状态机",
      boundary: "POST /sessions → ready/failed;created→provisioning→starting→ready(五态两终态)",
      owner: "packages/control-plane 单写,apps/control-worker 消费",
      section: "3.1",
      anchors: [],
    });
    expect(loop.status).toBe("unverified"); // default
    expect(loop.scenarios).toEqual([]); // default
  });

  it("parses an embedded submachine with a parent (L1a under L1)", () => {
    const loop = Loop.parse({
      id: "L1a",
      kind: "loop",
      title: "↳ Gate 聚合(内嵌)",
      boundary: "五闸门 worker/ingress/resource_mount/workspace_restore/agent_bootstrap 两相扫描",
      owner: "packages/control-plane 单写,apps/control-worker 消费",
      parent: "L1",
      embedded: true,
    });
    expect(loop.parent).toBe("L1");
    expect(loop.embedded).toBe(true);
  });

  it("parses a dormant loop with no owner (N8, M2 休眠)", () => {
    const loop = Loop.parse({
      id: "N8",
      kind: "loop",
      title: "Pipeline Run Workload fan-out",
      boundary: "repoint/eval(M2 休眠,schema 已落编排零写点)",
      owner: null,
      dormant: true,
    });
    expect(loop.owner).toBeNull();
    expect(loop.dormant).toBe(true);
  });

  it("rejects a loop id that doesn't match the L/N convention", () => {
    expect(() =>
      Loop.parse({
        id: "loop-99",
        kind: "loop",
        title: "bad id",
        boundary: "x",
        owner: "y",
      }),
    ).toThrow();
  });
});

describe("DebtEntry schema — different shape than Loop", () => {
  it("parses a dead-state-machine entry (merge_requests.status)", () => {
    const debt = DebtEntry.parse({
      id: "DEBT-DEADSTATE-merge-requests-status",
      kind: "debt",
      category: "dead_state_machine",
      subject: "merge_requests.status",
      claim: "5 态状态机(creating/open/merged/closed/failed)",
      reality: "完全架空死表:全仓零 writer,v2 delivery 直调 GitLab API 绕过此 v1 表",
    });
    expect(debt.category).toBe("dead_state_machine");
  });

  it("parses a deferred entry (Gateway session-token 验签缓存)", () => {
    const debt = DebtEntry.parse({
      id: "DEBT-DEFERRED-gateway-session-token-cache",
      kind: "debt",
      category: "deferred",
      subject: "Gateway session-token 验签缓存",
      reality: "credential-cache 明确注明故意排除(撤销语义敏感),不是遗漏",
    });
    expect(debt.category).toBe("deferred");
  });

  it("rejects a debt id that doesn't match the DEBT-xxx convention", () => {
    expect(() =>
      DebtEntry.parse({
        id: "not-a-debt-id",
        kind: "debt",
        category: "other",
        subject: "s",
        reality: "r",
      }),
    ).toThrow();
  });

  it("has no `owner`/`boundary`/`advance` fields — DebtEntry is not a Loop", () => {
    // TS-level: DebtEntry's shape has no `boundary` or `owner` required keys.
    // Runtime check: parsing something with Loop-shaped fields but missing
    // `reality` (DebtEntry's required field) must fail as a DebtEntry.
    expect(() =>
      DebtEntry.parse({
        id: "DEBT-X",
        kind: "debt",
        category: "other",
        subject: "x",
        // missing `reality`
      }),
    ).toThrow();
  });
});

describe("Evidence schema — kind taxonomy + note discipline (Proposal 006 A1)", () => {
  it("accepts every runtime/code kind", () => {
    for (const kind of ["test", "durable_event", "e2e", "metric", "trace", "log", "code"]) {
      const e = Evidence.parse({ id: `E-${kind}`, kind, anchor: "path/to/file.ts#Sym" });
      expect(e.kind).toBe(kind);
    }
  });

  it("accepts the new intent/planning kinds spec and issue (A1)", () => {
    for (const kind of ["spec", "issue"]) {
      const e = Evidence.parse({ id: `E-${kind}`, kind, anchor: "docs/architecture/x.md#L10-L20" });
      expect(e.kind).toBe(kind);
    }
  });

  it("rejects an unknown evidence kind", () => {
    expect(() => Evidence.parse({ id: "E-x", kind: "rumor", anchor: "a#b" })).toThrow();
  });

  it("accepts a note up to EVIDENCE_NOTE_MAX chars", () => {
    const note = "x".repeat(EVIDENCE_NOTE_MAX);
    const e = Evidence.parse({ id: "E-note", kind: "spec", anchor: "a#b", note });
    expect(e.note).toHaveLength(EVIDENCE_NOTE_MAX);
  });

  it("rejects a note longer than EVIDENCE_NOTE_MAX — long prose belongs in the source doc, not the pointer", () => {
    const note = "x".repeat(EVIDENCE_NOTE_MAX + 1);
    expect(() => Evidence.parse({ id: "E-note", kind: "spec", anchor: "a#b", note })).toThrow();
  });
});

describe("Junction schema — risk_class taxonomy", () => {
  it("accepts all 5 risk classes from #1276 §5", () => {
    const classes = ["handoff", "idempotency", "projection", "failure_propagation", "watchdog"];
    for (const risk_class of classes) {
      const junction = Junction.parse({
        id: `J-${risk_class}-example`,
        kind: "junction",
        risk_class,
        between: ["L1", "L2"],
      });
      expect(junction.risk_class).toBe(risk_class);
    }
  });

  it("rejects an unknown risk class", () => {
    expect(() =>
      Junction.parse({
        id: "J-bad",
        kind: "junction",
        risk_class: "made_up_class",
        between: ["L1", "L2"],
      }),
    ).toThrow();
  });
});

describe("Scenario schema — optional applies_to selector (effective constraints, Decision 004)", () => {
  it("parses a Scenario with no applies_to (ordinary GWT, unchanged behavior)", () => {
    const s = Scenario.parse({
      id: "GWT-C1-001",
      kind: "scenario",
      given: "g",
      when: "w",
      // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
      then: "t",
      level: "unit",
    });
    expect(s.applies_to).toBeUndefined();
  });

  it("parses applies_to with only owner_match, defaulting nodes to []", () => {
    const s = Scenario.parse({
      id: "GWT-INV-001",
      kind: "scenario",
      given: "g",
      when: "w",
      // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
      then: "t",
      level: "unit",
      applies_to: { owner_match: "packages/control-plane" },
    });
    expect(s.applies_to?.nodes).toEqual([]);
    expect(s.applies_to?.owner_match).toBe("packages/control-plane");
  });

  it("parses applies_to with an explicit nodes array, preserving element order", () => {
    const s = Scenario.parse({
      id: "GWT-INV-002",
      kind: "scenario",
      given: "g",
      when: "w",
      // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
      then: "t",
      level: "unit",
      applies_to: { nodes: ["L1", "L9", "J-outbox-poller"] },
    });
    expect(s.applies_to?.nodes).toEqual(["L1", "L9", "J-outbox-poller"]);
    expect(s.applies_to?.owner_match).toBeUndefined();
  });

  it("rejects applies_to with the wrong shape (not an object)", () => {
    expect(() =>
      Scenario.parse({
        id: "GWT-INV-003",
        kind: "scenario",
        given: "g",
        when: "w",
        // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
        then: "t",
        level: "unit",
        applies_to: "nodes",
      }),
    ).toThrow();
  });

  it("rejects an empty owner_match — it would silently match every non-dormant Loop, so reject rather than allow the footgun", () => {
    expect(() =>
      Scenario.parse({
        id: "GWT-INV-004",
        kind: "scenario",
        given: "g",
        when: "w",
        // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
        then: "t",
        level: "unit",
        applies_to: { owner_match: "" },
      }),
    ).toThrow();
  });
});

describe("Flow schema — references loops not yet detailed", () => {
  it("parses C1 with sub-flow references (C2/C3) that exist only as stub flow ids", () => {
    const c1 = Flow.parse({
      id: "C1",
      kind: "flow",
      title: "一次对话端到端",
      traverses: ["L1", "L2", "L15", "L3", "L4", "L16"],
      guarded_by: ["L9"],
      references: ["C2", "C3"],
    });
    expect(c1.references).toEqual(["C2", "C3"]);
    expect(c1.status).toBe("unverified"); // default; nothing verified in a fresh import
  });

  it("accepts an optional plain-language `summary` and defaults it to undefined", () => {
    const withSummary = Flow.parse({
      id: "C1",
      kind: "flow",
      title: "一次对话端到端",
      summary: "发一条消息 → 系统跑完 → 回复送达",
    });
    expect(withSummary.summary).toBe("发一条消息 → 系统跑完 → 回复送达");
    const without = Flow.parse({ id: "C2", kind: "flow", title: "无摘要" });
    expect(without.summary).toBeUndefined();
  });
});

describe("ModelNode discriminated union", () => {
  it("dispatches on `kind` across all 6 node types including debt", () => {
    const nodes = [
      { id: "F-conversation", kind: "feature", title: "一次对话" },
      { id: "C1", kind: "flow", title: "C1" },
      { id: "L1", kind: "loop", title: "L1", boundary: "b", owner: "o" },
      { id: "J-x", kind: "junction", risk_class: "handoff", between: ["L1", "L2"] },
      {
        id: "GWT-C1-001",
        kind: "scenario",
        given: "g",
        when: "w",
        // biome-ignore lint/suspicious/noThenProperty: GWT domain vocabulary, not a thenable
        then: "t",
        level: "unit",
      },
      { id: "DEBT-X", kind: "debt", category: "other", subject: "s", reality: "r" },
    ];
    for (const raw of nodes) {
      expect(() => ModelNode.parse(raw)).not.toThrow();
    }
  });
});
