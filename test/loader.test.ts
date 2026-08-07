import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModel } from "../src/loader/load-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

describe("loadModel", () => {
  it("loads both array-of-nodes and single-node yaml files, across subdirs", async () => {
    const result = await loadModel(join(fixtures, "valid-model"));
    expect(result.parseErrors).toEqual([]);
    expect(result.duplicateIds).toEqual([]);
    expect(result.graph.byKind.loop.size).toBe(3); // L1, L1a, L2
    expect(result.graph.byKind.flow.size).toBe(1); // C1
    expect(result.graph.byKind.loop.get("L1a")?.parent).toBe("L1");
    expect(result.graph.sourceFile.get("C1")).toContain("flows");
  });

  it("collects schema/parse errors instead of throwing", async () => {
    const result = await loadModel(join(fixtures, "broken-model"));
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0]?.file).toBe("bad.yaml");
    expect(result.parseErrors[0]?.message).toContain("schema validation failed");
  });

  it("detects duplicate ids across different files (same kind — id namespaces are kind-exclusive by regex construction)", async () => {
    const result = await loadModel(join(fixtures, "duplicate-id-model"));
    expect(result.parseErrors).toEqual([]);
    expect(result.duplicateIds).toHaveLength(1);
    expect(result.duplicateIds[0]?.id).toBe("L1");
    expect(result.duplicateIds[0]?.files.sort()).toEqual(["a.yaml", "b.yaml"]);
    // first occurrence still wins in the graph so downstream queries don't crash
    expect(result.graph.byKind.loop.has("L1")).toBe(true);
  });

  it("isolates a malformed element in an array file — valid siblings still load", async () => {
    const result = await loadModel(join(fixtures, "partially-broken-array"));
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0]?.file).toBe("loops.yaml (item 1)");
    // the two valid siblings (item 0 and item 2) are NOT collateral damage
    expect(result.graph.byKind.loop.has("L1")).toBe(true);
    expect(result.graph.byKind.loop.has("L2")).toBe(true);
    expect(result.graph.byKind.loop.size).toBe(2);
  });

  it("throws a clear, actionable error for a missing model directory instead of a raw ENOENT", async () => {
    // Found via real usage against a target-repo checkout that had no model/
    // dir yet: a bare `readdir` ENOENT surfaced as an opaque Node stack
    // trace with no hint about `codeontic init`/`import`.
    await expect(loadModel(join(fixtures, "this-directory-does-not-exist"))).rejects.toThrow(
      /model directory .* is not found.*codeontic init.*codeontic import/s,
    );
  });

  it("throws a clear error when the model path exists but is a file, not a directory", async () => {
    // ENOTDIR: pointing `check` at a yaml file instead of its containing dir.
    await expect(loadModel(join(fixtures, "valid-model", "flows", "C1.yaml"))).rejects.toThrow(
      /is not a directory/,
    );
  });
});
