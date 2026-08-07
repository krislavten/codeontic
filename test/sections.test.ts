import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MARKER_END, MARKER_START, upsertManagedSection } from "../src/hosts/sections.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-sections-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("upsertManagedSection", () => {
  it("creates a new file with markers when it does not exist", async () => {
    const path = join(workDir, "new.md");
    const result = await upsertManagedSection(path, "hello world");
    expect(result.outcome).toBe("created");
    const content = await readFile(path, "utf8");
    expect(content).toBe(`${MARKER_START}\nhello world\n${MARKER_END}\n`);
  });

  it("creates parent directories if needed", async () => {
    const path = join(workDir, "deep", "nested", "file.md");
    const result = await upsertManagedSection(path, "nested content");
    expect(result.outcome).toBe("created");
    const content = await readFile(path, "utf8");
    expect(content).toContain("nested content");
  });

  it("replaces content between markers when both exist", async () => {
    const path = join(workDir, "existing.md");
    await writeFile(
      path,
      `user notes above\n${MARKER_START}\nold managed content\n${MARKER_END}\nuser notes below\n`,
      "utf8",
    );
    const result = await upsertManagedSection(path, "new managed content");
    expect(result.outcome).toBe("replaced");
    const content = await readFile(path, "utf8");
    expect(content).toContain("user notes above");
    expect(content).toContain("new managed content");
    expect(content).toContain("user notes below");
    expect(content).not.toContain("old managed content");
  });

  it("returns unchanged when content is identical — no disk write", async () => {
    const path = join(workDir, "same.md");
    await writeFile(path, `${MARKER_START}\nsame content\n${MARKER_END}\n`, "utf8");
    const result = await upsertManagedSection(path, "same content");
    expect(result.outcome).toBe("unchanged");
  });

  it("appends a managed block when file exists without markers", async () => {
    const path = join(workDir, "no-markers.md");
    await writeFile(path, "existing user content\n", "utf8");
    const result = await upsertManagedSection(path, "managed body");
    expect(result.outcome).toBe("appended");
    const content = await readFile(path, "utf8");
    expect(content).toContain("existing user content");
    expect(content).toContain(MARKER_START);
    expect(content).toContain("managed body");
    expect(content).toContain(MARKER_END);
  });

  it("CRLF file round-trips without double \\r", async () => {
    const path = join(workDir, "crlf.md");
    await writeFile(path, `user\r\n${MARKER_START}\r\nold\r\n${MARKER_END}\r\nuser2\r\n`, "utf8");
    const result = await upsertManagedSection(path, "new content");
    expect(result.outcome).toBe("replaced");
    const content = await readFile(path, "utf8");
    // Content should use CRLF line endings
    expect(content).toContain("\r\n");
    // No double \r
    expect(content).not.toContain("\r\r");
    expect(content).toContain("new content");
    expect(content).toContain("user2");
  });

  it("marker text in the middle of a line is not matched (must be on its own line)", async () => {
    const path = join(workDir, "inline-marker.md");
    await writeFile(
      path,
      `some text ${MARKER_START} more text\nsome text ${MARKER_END} more text\n`,
      "utf8",
    );
    const result = await upsertManagedSection(path, "new body");
    expect(result.outcome).toBe("appended");
    const content = await readFile(path, "utf8");
    // Original content preserved, managed block appended
    expect(content).toContain(`some text ${MARKER_START} more text`);
  });

  it("marker hand-deleted → treated as no-marker file, appends new block", async () => {
    const path = join(workDir, "deleted-markers.md");
    await writeFile(path, "file had markers before but they were removed\n", "utf8");
    const result = await upsertManagedSection(path, "restored body");
    expect(result.outcome).toBe("appended");
    const content = await readFile(path, "utf8");
    expect(content).toContain(MARKER_START);
    expect(content).toContain("restored body");
  });

  it("double-run: second run reports unchanged with zero fs mutation", async () => {
    const path = join(workDir, "double.md");
    await upsertManagedSection(path, "body text");
    const first = await readFile(path, "utf8");
    const result = await upsertManagedSection(path, "body text");
    expect(result.outcome).toBe("unchanged");
    const second = await readFile(path, "utf8");
    expect(second).toBe(first);
  });

  it("multiline body with empty lines is preserved correctly", async () => {
    const path = join(workDir, "multiline.md");
    const body = "line one\n\nline three\n  indented";
    await upsertManagedSection(path, body);
    const content = await readFile(path, "utf8");
    expect(content).toContain("line one\n\nline three\n  indented");
  });
});
