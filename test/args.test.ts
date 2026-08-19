import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOOLEAN_FLAGS, parseFlags } from "../src/cli/args.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("parseFlags", () => {
  it("a boolean flag never consumes the next token", () => {
    const { positionals, flags } = parseFlags(["--strict-anchors", "/repo"]);
    expect(flags["strict-anchors"]).toBe(true);
    expect(positionals).toEqual(["/repo"]);
  });

  it("a value flag still takes its value", () => {
    const { positionals, flags } = parseFlags(["--repo-root", "/repo", "dir"]);
    expect(flags["repo-root"]).toBe("/repo");
    expect(positionals).toEqual(["dir"]);
  });

  it("a value flag with no value left is boolean true (so callers can detect it)", () => {
    expect(parseFlags(["--repo-root"]).flags["repo-root"]).toBe(true);
  });

  /**
   * The list of boolean flags is hand-kept, and its first version missed three
   * of them — each read with a spelling the author had not grepped for. The
   * cost of a miss is silent: the flag swallows the next argument, so the flag
   * itself reads as "not set" AND the positional it ate goes missing.
   *
   * So the truth is derived from the dispatcher instead of trusted: every flag
   * the dispatcher compares against `true` must be declared here.
   */
  it("every flag the dispatcher reads as boolean is declared boolean", async () => {
    const source = await readFile(join(here, "..", "src", "cli", "run.ts"), "utf8");
    const read = new Set<string>();
    for (const m of source.matchAll(/flags\["([a-z-]+)"\]\s*[!=]==\s*true/g)) {
      read.add(m[1] as string);
    }
    for (const m of source.matchAll(/flags\.([a-zA-Z]+)\s*[!=]==\s*true/g)) {
      read.add(m[1] as string);
    }
    expect(read.size).toBeGreaterThan(5); // the scan actually found things
    const missing = [...read].filter((f) => !BOOLEAN_FLAGS.has(f));
    expect(missing).toEqual([]);
  });
});
