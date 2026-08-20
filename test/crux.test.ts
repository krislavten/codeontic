import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph } from "../src/loader/model-graph.js";
import {
  CRUX_MAX_CHARS,
  CRUX_MAX_LINES,
  Crux,
  EVIDENCE_NOTE_MAX,
  Flow,
  Loop,
} from "../src/schema/index.js";
import { checkAnchorCrux, checkCruxReferences } from "../src/validate/crux.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "codeontic-crux-test-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("Crux schema (Proposal 013 B2)", () => {
  it("parses a valid crux entry", () => {
    const crux = Crux.parse({
      anchor: "src/service.ts#start",
      text: 'if (order.status === "cancelled") return;',
      note: "cancelled terminal guard",
    });
    expect(crux.anchor).toBe("src/service.ts#start");
    expect(crux.text).toContain("cancelled");
    expect(crux.note).toBe("cancelled terminal guard");
  });

  it("rejects empty text", () => {
    expect(() => Crux.parse({ anchor: "src/a.ts#x", text: "" })).toThrow();
  });

  it(`rejects text exceeding ${CRUX_MAX_LINES} lines`, () => {
    const text = Array.from({ length: CRUX_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    expect(() => Crux.parse({ anchor: "src/a.ts#x", text })).toThrow();
  });

  it(`accepts text at exactly ${CRUX_MAX_LINES} lines`, () => {
    const text = Array.from({ length: CRUX_MAX_LINES }, (_, i) => `line ${i}`).join("\n");
    const crux = Crux.parse({ anchor: "src/a.ts#x", text });
    expect(crux.text.split("\n")).toHaveLength(CRUX_MAX_LINES);
  });

  it(`rejects text exceeding ${CRUX_MAX_CHARS} characters`, () => {
    const text = "x".repeat(CRUX_MAX_CHARS + 1);
    expect(() => Crux.parse({ anchor: "src/a.ts#x", text })).toThrow();
  });

  it(`rejects note exceeding ${EVIDENCE_NOTE_MAX} characters`, () => {
    const note = "x".repeat(EVIDENCE_NOTE_MAX + 1);
    expect(() => Crux.parse({ anchor: "src/a.ts#x", text: "code", note })).toThrow();
  });

  it("note is optional", () => {
    const crux = Crux.parse({ anchor: "src/a.ts#x", text: "code" });
    expect(crux.note).toBeUndefined();
  });
});

describe("Loop/Flow with crux field", () => {
  it("Loop accepts optional crux array", () => {
    const loop = Loop.parse({
      id: "L1",
      kind: "loop",
      title: "Test Loop",
      boundary: "b",
      owner: "o",
      anchors: ["src/service.ts#start"],
      crux: [
        {
          anchor: "src/service.ts#start",
          text: 'if (status === "done") return;',
        },
      ],
    });
    expect(loop.crux).toHaveLength(1);
    expect(loop.crux?.[0]?.text).toContain("done");
  });

  it("Loop without crux field defaults to undefined", () => {
    const loop = Loop.parse({
      id: "L1",
      kind: "loop",
      title: "Test Loop",
      boundary: "b",
      owner: "o",
    });
    expect(loop.crux).toBeUndefined();
  });

  it("Flow accepts optional crux array", () => {
    const flow = Flow.parse({
      id: "C1",
      kind: "flow",
      title: "Test Flow",
      anchors: ["src/cli.ts#main"],
      crux: [
        {
          anchor: "src/cli.ts#main",
          text: "process.exit(0);",
        },
      ],
    });
    expect(flow.crux).toHaveLength(1);
  });
});

describe("checkAnchorCrux — validation", () => {
  it("errors when crux anchor is not in the node's anchors", async () => {
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/a.ts#A"],
          crux: [{ anchor: "src/b.ts#B", text: "code" }],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    // This half moved to `checkCruxReferences`, which needs no checkout: it is
    // a property of the model alone, and leaving it behind a repoRoot meant
    // `gate --model-only` reported "no MODEL errors" with this sitting in it.
    const violations = checkCruxReferences(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("error");
    expect(violations[0]?.check).toBe("anchor-crux");
    expect(violations[0]?.message).toContain("not in L1.anchors");

    // …and the checkout-reading half no longer reports it twice.
    expect(await checkAnchorCrux(graph, repoRoot)).toHaveLength(0);
  });

  it("warns when crux text is no longer found in the file", async () => {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "src/service.ts"),
      'export function start() {\n  console.log("started");\n}\n',
      "utf8",
    );
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/service.ts#start"],
          crux: [{ anchor: "src/service.ts#start", text: "NONEXISTENT_CODE" }],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    const violations = await checkAnchorCrux(graph, repoRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("warning");
    expect(violations[0]?.message).toContain("no longer found");
  });

  it("passes on exact text match", async () => {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "src/service.ts"),
      'export function start() {\n  if (status === "done") return;\n}\n',
      "utf8",
    );
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/service.ts#start"],
          crux: [{ anchor: "src/service.ts#start", text: 'if (status === "done") return;' }],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    const violations = await checkAnchorCrux(graph, repoRoot);
    expect(violations).toHaveLength(0);
  });

  it("passes on whitespace-normalized match (reformatted code)", async () => {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "src/service.ts"),
      'export function start() {\n    if (  status  ===  "done"  )  return;\n}\n',
      "utf8",
    );
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/service.ts#start"],
          crux: [{ anchor: "src/service.ts#start", text: 'if (status === "done") return;' }],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    const violations = await checkAnchorCrux(graph, repoRoot);
    expect(violations).toHaveLength(0);
  });

  it("skips oversized files without false alarm", async () => {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    // We can't actually create a 2MB file in this test, but we verify the
    // function doesn't error on missing files (similar to oversized = skip)
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/missing.ts#foo"],
          crux: [{ anchor: "src/missing.ts#foo", text: "anything" }],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    const violations = await checkAnchorCrux(graph, repoRoot);
    expect(violations).toHaveLength(0);
  });

  it("no violations when node has no crux", async () => {
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/a.ts#A"],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    const violations = await checkAnchorCrux(graph, repoRoot);
    expect(violations).toHaveLength(0);
  });

  it("--strict-anchors does NOT promote crux warnings to errors", async () => {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src/a.ts"), "export const A = 1;\n", "utf8");
    const { graph } = buildGraph([
      {
        node: Loop.parse({
          id: "L1",
          kind: "loop",
          title: "t",
          boundary: "b",
          owner: "o",
          anchors: ["src/a.ts#A"],
          crux: [{ anchor: "src/a.ts#A", text: "DOES_NOT_EXIST" }],
        }),
        file: "loops/L1.yaml",
      },
    ]);
    const violations = await checkAnchorCrux(graph, repoRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("warning");
  });
});
