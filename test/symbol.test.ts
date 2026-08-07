import { describe, expect, it } from "vitest";
import { fileMentionsSymbol, isParseableSource, mentionsWord } from "../src/validate/symbol.js";

describe("isParseableSource", () => {
  it("accepts TS/JS source extensions and nothing else", () => {
    expect(isParseableSource("apps/a/src/x.ts")).toBe(true);
    expect(isParseableSource("apps/a/app/page.tsx")).toBe(true);
    expect(isParseableSource("scripts/build.mjs")).toBe(true);
    expect(isParseableSource("packages/schemas")).toBe(false); // directory-style anchor
    expect(isParseableSource("docs/design.md")).toBe(false);
    expect(isParseableSource("Makefile")).toBe(false);
  });
});

describe("mentionsWord", () => {
  it("matches whole words only", () => {
    expect(mentionsWord("buffer.seedSeq(41);", "seedSeq")).toBe(true);
    expect(mentionsWord("// `seedSeq` re-seeds from persisted max", "seedSeq")).toBe(true);
    expect(mentionsWord("buffer.seedSeqAll();", "seedSeq")).toBe(false);
    expect(mentionsWord("const mySeedSeq = 1;", "seedSeq")).toBe(false);
  });

  it("treats regex metacharacters in the symbol as literals", () => {
    expect(mentionsWord("value.a$b", "a$b")).toBe(true);
    expect(mentionsWord("nothing here", "a.c")).toBe(false); // "." must not act as any-char
  });
});

describe("fileMentionsSymbol", () => {
  const FILE = "apps/control-worker/src/orchestration/index.ts";

  it("finds a declaration", () => {
    const src = "class O {\n  private startCheckpointTimer(run: Run) { return 1; }\n}";
    expect(fileMentionsSymbol(FILE, src, "startCheckpointTimer")).toBe(true);
  });

  it("finds a call site — a scenario may anchor the test that EXERCISES a symbol", () => {
    // real case: v2-full-roundtrip.integration.test.ts#handleWorkerProtocolEvent, where the
    // name only ever appears as "svc.handleWorkerProtocolEvent(...)".
    const src = "const result = await svc.handleWorkerProtocolEvent({ id });";
    expect(fileMentionsSymbol("t/x.test.ts", src, "handleWorkerProtocolEvent")).toBe(true);
  });

  it("finds a test-block title mention", () => {
    // real case: describe("RunService.handleWorkerProtocolEvent (R-RSM-05)", ...)
    const src = 'describe("RunService.handleWorkerProtocolEvent (R-RSM-05)", () => {});';
    expect(fileMentionsSymbol("t/x.test.ts", src, "handleWorkerProtocolEvent")).toBe(true);
  });

  it("finds a doc-comment mention — anchoring documented behaviour is legitimate", () => {
    // real case: cross-instance-dedup.integration.test.ts#finalizeEnqueue appears
    // exactly once, inside a block comment describing what the test covers.
    const src = '/**\n * "finalizeEnqueue" UPDATE pattern. Everything runs in this JS\n */';
    expect(fileMentionsSymbol("t/x.test.ts", src, "finalizeEnqueue")).toBe(true);
  });

  it("reports missing when the name is gone from the file entirely — the case that rots", () => {
    const src = "class O {\n  private startSomethingElse() { return 1; }\n}";
    expect(fileMentionsSymbol(FILE, src, "startCheckpointTimer")).toBe(false);
  });

  it("matches a dotted symbol on its head segment only", () => {
    const src = "export const SessionEventSchema = z.object({});";
    expect(fileMentionsSymbol("p/s.ts", src, "SessionEventSchema.idle_warning")).toBe(true);
  });

  it("returns undefined (unknown, never missing) for non-source paths", () => {
    expect(fileMentionsSymbol("packages/schemas", "whatever", "EventSchema")).toBeUndefined();
  });
});
