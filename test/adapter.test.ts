import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistrationError,
  adapterNames,
  clearRegistry,
  getAdapter,
  registerAdapter,
  validateAdapter,
} from "../src/adapters/registry.js";
import type { Adapter, ImplementationFact } from "../src/adapters/types.js";
import { runFacts } from "../src/facts/runner.js";

/**
 * A minimal synthetic adapter (Proposal 010 — no adapter ships with this
 * engine; registry/runner tests exercise the Adapter *interface*, not any
 * particular target's extraction logic). Recognizes a literal "MARKER" token.
 */
const syntheticAdapter: Adapter = {
  interfaceVersion: "v2",
  name: "synthetic",
  version: "synthetic-1",
  candidatePattern: "MARKER",
  extractFacts(filePath: string, content: string): ImplementationFact[] {
    if (!content.includes("MARKER")) return [];
    return [{ signal: "synthetic_marker", name: "found", filePath, line: 1 }];
  },
};

describe("adapter registry (Proposal 010 — empty by default, no built-in adapter)", () => {
  afterEach(() => clearRegistry());

  it("is empty until an adapter is registered; unknown name → undefined", () => {
    expect(adapterNames()).toEqual([]);
    expect(getAdapter("synthetic")).toBeUndefined();
  });

  it("registerAdapter adds it to the name-keyed lookup", () => {
    registerAdapter(syntheticAdapter);
    expect(adapterNames()).toContain("synthetic");
    expect(getAdapter("synthetic")?.name).toBe("synthetic");
    expect(getAdapter("nope")).toBeUndefined();
  });

  it("registerAdapter rejects a re-registration of the same name", () => {
    registerAdapter(syntheticAdapter);
    expect(() => registerAdapter(syntheticAdapter)).toThrow(AdapterRegistrationError);
  });

  it("validateAdapter (stateless) rejects an interfaceVersion mismatch", () => {
    const wrongVersion = {
      ...syntheticAdapter,
      interfaceVersion: "v0-wrong",
    } as unknown as Adapter;
    expect(() => validateAdapter(wrongVersion)).toThrow(/interfaceVersion/);
  });

  it("validateAdapter rejects an async extractFacts (sync-only MVP contract)", () => {
    const asyncExtractFacts = async (f: string, c: string) =>
      Promise.resolve(syntheticAdapter.extractFacts(f, c));
    const asyncAdapter = {
      ...syntheticAdapter,
      extractFacts: asyncExtractFacts,
    } as unknown as Adapter;
    expect(() => validateAdapter(asyncAdapter)).toThrow(/async function/);
  });

  it("ships NO defaultInv1Config by default — the guarded-table config is target-repo knowledge, not baked into the package", () => {
    expect(syntheticAdapter.defaultInv1Config).toBeUndefined();
  });

  it("runFacts drives extraction through the caller-supplied adapter (no built-in default)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeontic-adapter-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "w.ts"), "const x = 1; // MARKER");
      execFileSync("git", ["add", "-A"], { cwd: dir });

      const r = await runFacts(dir, { cacheDir: null, adapter: syntheticAdapter });
      expect(r.ran).toBe(true);
      expect(r.facts.map((f) => f.name)).toEqual(["found"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
