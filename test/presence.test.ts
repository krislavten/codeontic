import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SYMBOL_SCAN_BYTES, resolveAnchorPresence } from "../src/validate/presence.js";

/**
 * `resolveAnchorPresence` is the single filesystem pass `check` and
 * `conformance` now share (Proposal 016 T6), so the thing worth testing hardest
 * is its ONE dangerous failure mode: reporting an anchor stale when it merely
 * could not tell. Every "cannot tell" path gets its own case rather than one
 * aggregate assertion — a regression that collapses any single one of them into
 * "stale" turns a report card's `met` into a false `gap`, and an aggregate test
 * would still pass on the other three.
 */
describe("resolveAnchorPresence — existence + symbol/text presence in one pass", () => {
  let repo: string;

  async function write(rel: string, content: string): Promise<void> {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-presence-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports a present file whose symbol is present as neither missing nor stale", async () => {
    await write("src/a.ts", "export class Widget {}\n");
    const p = await resolveAnchorPresence(repo, { anchors: ["src/a.ts#Widget"] });
    expect(p.existingFiles).toEqual(new Set(["src/a.ts"]));
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("reports a present file whose symbol is gone as STALE (the P0 case), not missing", async () => {
    await write("src/a.ts", "export class Widget {}\n");
    const p = await resolveAnchorPresence(repo, { anchors: ["src/a.ts#NoSuchClass"] });
    expect(p.existingFiles.has("src/a.ts")).toBe(true);
    expect(p.staleSymbolAnchors).toEqual(new Set(["src/a.ts#NoSuchClass"]));
  });

  it("leaves an absent file out of existingFiles and does NOT also call it stale", async () => {
    const p = await resolveAnchorPresence(repo, { anchors: ["src/gone.ts#Widget"] });
    expect(p.existingFiles.size).toBe(0);
    // A missing file is already reported as missing; adding "stale" on top
    // would double-count one defect as two gaps on the report card.
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("cannot tell #1 — a non-TS/JS file's symbol is never stale (docs, SQL, config)", async () => {
    await write("docs/spec.md", "# nothing in here mentions the anchor\n");
    const p = await resolveAnchorPresence(repo, { anchors: ["docs/spec.md#handoff_contract"] });
    expect(p.existingFiles.has("docs/spec.md")).toBe(true);
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("cannot tell #2 — a file over the scan cap is never stale", async () => {
    await write("src/huge.ts", "x".repeat(MAX_SYMBOL_SCAN_BYTES + 1));
    const p = await resolveAnchorPresence(repo, { anchors: ["src/huge.ts#Widget"] });
    expect(p.existingFiles.has("src/huge.ts")).toBe(true);
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("cannot tell #3 — an unreadable path (a directory) exists but is never stale", async () => {
    // `packages/schemas#EventSchema` — a directory path is a documented anchor
    // shape (see anchor.ts), so it must resolve as present, not as deleted.
    await mkdir(join(repo, "packages/schemas.ts"), { recursive: true });
    const p = await resolveAnchorPresence(repo, { anchors: ["packages/schemas.ts#EventSchema"] });
    expect(p.existingFiles.has("packages/schemas.ts")).toBe(true);
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("cannot tell #4 — a dotted symbol is judged on its HEAD only", async () => {
    // The tail names a member of a value (a zod field, an enum case); proving
    // it exists means evaluating the module, so only the head is checked.
    await write("src/schema.ts", "export const EventSchema = {};\n");
    const p = await resolveAnchorPresence(repo, {
      anchors: ["src/schema.ts#EventSchema.idle_warning"],
    });
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("matches a text anchor exactly and whitespace-normalized (the crux matcher)", async () => {
    // The title is wrapped across two source lines, as a formatter would leave it.
    await write(
      "test/a.spec.ts",
      [
        'it("claimAsRunning transitions QUEUED -> RUNNING',
        '    and returns the job", () => {});',
      ].join("\n"),
    );
    const p = await resolveAnchorPresence(repo, {
      anchors: [],
      textAnchors: [
        { file: "test/a.spec.ts", text: "claimAsRunning transitions QUEUED -> RUNNING" },
        // Reflowed across the line break in the source — tier 2 must still hit.
        { file: "test/a.spec.ts", text: "QUEUED -> RUNNING and returns the job" },
      ],
    });
    expect(p.staleTextAnchors.size).toBe(0);
  });

  it("reports a text anchor whose title was reworded as stale, keyed by its label", async () => {
    await write("test/a.spec.ts", 'it("a completely different title", () => {});\n');
    const p = await resolveAnchorPresence(repo, {
      anchors: [],
      textAnchors: [{ file: "test/a.spec.ts", text: "the original title" }],
    });
    expect(p.staleTextAnchors).toEqual(new Set(['test/a.spec.ts :: "the original title"']));
  });

  it("reads each distinct file ONCE however many anchors point into it", async () => {
    // The dedup is what keeps the added read inside the sub-second budget; a
    // regression to per-anchor reads is invisible except as a slow command, so
    // assert the shape that guarantees it: many anchors, one correct answer set.
    await write("src/a.ts", "export class Alpha {}\nexport class Beta {}\n");
    const anchors = ["src/a.ts#Alpha", "src/a.ts#Beta", "src/a.ts#Gamma", "src/a.ts#Delta"];
    const p = await resolveAnchorPresence(repo, { anchors });
    expect(p.existingFiles).toEqual(new Set(["src/a.ts"]));
    expect(p.staleSymbolAnchors).toEqual(new Set(["src/a.ts#Gamma", "src/a.ts#Delta"]));
  });

  it("ignores table-style anchors — they name no file to resolve", async () => {
    const p = await resolveAnchorPresence(repo, { anchors: ["jobs_table.payload", "sandboxes"] });
    expect(p.existingFiles.size).toBe(0);
    expect(p.staleSymbolAnchors.size).toBe(0);
  });

  it("never stats or reads through a parent-traversal segment (containment, 016 review)", async () => {
    // This module goes further than access(): it READS matching files to grep
    // for the symbol/text. Without containment re-assertion a `../` anchor in a
    // malformed model turns presence resolution into a yes/no oracle over
    // out-of-repo files. Skipped = unknown, not stale — same posture as the
    // four cannot-tell cases above.
    const outside = join(repo, "..", `outside-${Date.now()}.ts`);
    await writeFile(outside, "export const password123 = 1;\n");
    try {
      const p = await resolveAnchorPresence(repo, {
        anchors: ["../secret.ts#password123", "../secret.ts#not_in_the_file"],
        textAnchors: [{ file: "../secret.ts", text: "password123" }],
      });
      expect(p.existingFiles.size).toBe(0);
      expect(p.staleSymbolAnchors.size).toBe(0);
      expect(p.staleTextAnchors.size).toBe(0);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
