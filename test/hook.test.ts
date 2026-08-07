import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHookPostEdit, runHookSessionStart } from "../src/cli/commands/hook.js";

let targetDir: string;

beforeEach(async () => {
  targetDir = await mkdtemp(join(tmpdir(), "codeontic-hook-test-"));
});

afterEach(async () => {
  await rm(targetDir, { recursive: true, force: true });
});

async function writeModel(nodes: Record<string, unknown>[]) {
  const modelDir = join(targetDir, ".codeontic", "model", "loops");
  await mkdir(modelDir, { recursive: true });
  await writeFile(
    join(modelDir, "test.yaml"),
    nodes.map((n) => JSON.stringify(n)).join("\n---\n"),
    "utf8",
  );
}

async function writeYaml(relPath: string, content: string) {
  const dir = join(targetDir, ".codeontic", "model", relPath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(join(targetDir, ".codeontic", "model", relPath), content, "utf8");
}

describe("runHookPostEdit", () => {
  it("returns context when file is model-anchored", async () => {
    await writeYaml(
      "loops/L1.yaml",
      'id: L1\nkind: loop\ntitle: "Order Loop"\nboundary: "pending → done"\nowner: team-a\nanchors:\n  - src/order.ts#process\n',
    );

    const stdin = JSON.stringify({
      tool_input: { file_path: join(targetDir, "src/order.ts") },
    });
    const result = await runHookPostEdit(targetDir, stdin);
    expect(result).toContain("[codeontic]");
    expect(result).toContain("L1");
    expect(result).toContain("Order Loop");
    expect(result).toContain("codeontic check");
  });

  it("returns empty string when file is not anchored", async () => {
    await writeYaml(
      "loops/L1.yaml",
      'id: L1\nkind: loop\ntitle: "Order"\nboundary: b\nowner: o\nanchors:\n  - src/other.ts#x\n',
    );

    const stdin = JSON.stringify({
      tool_input: { file_path: join(targetDir, "src/unrelated.ts") },
    });
    const result = await runHookPostEdit(targetDir, stdin);
    expect(result).toBe("");
  });

  it("skips edits to .codeontic/ itself", async () => {
    await writeYaml(
      "loops/L1.yaml",
      "id: L1\nkind: loop\ntitle: t\nboundary: b\nowner: o\nanchors:\n  - .codeontic/model/loops/L1.yaml#id\n",
    );

    const stdin = JSON.stringify({
      tool_input: { file_path: join(targetDir, ".codeontic/model/loops/L1.yaml") },
    });
    const result = await runHookPostEdit(targetDir, stdin);
    expect(result).toBe("");
  });

  it("returns empty on malformed stdin JSON", async () => {
    const result = await runHookPostEdit(targetDir, "not json");
    expect(result).toBe("");
  });

  it("returns empty on empty stdin", async () => {
    const result = await runHookPostEdit(targetDir, "");
    expect(result).toBe("");
  });

  it("returns empty when model is empty", async () => {
    await mkdir(join(targetDir, ".codeontic", "model", "loops"), { recursive: true });

    const stdin = JSON.stringify({
      tool_input: { file_path: join(targetDir, "src/a.ts") },
    });
    const result = await runHookPostEdit(targetDir, stdin);
    expect(result).toBe("");
  });
});

describe("runHookSessionStart", () => {
  it("returns model overview with flow and loop counts", async () => {
    await writeYaml(
      "flows/C1.yaml",
      'id: C1\nkind: flow\ntitle: "Order Flow"\nanchors:\n  - src/flow.ts#main\ntraverses:\n  - L1\n',
    );
    await writeYaml(
      "loops/L1.yaml",
      'id: L1\nkind: loop\ntitle: "Order Loop"\nboundary: b\nowner: o\n',
    );

    const result = await runHookSessionStart(targetDir);
    expect(result).toContain("[codeontic] Model loaded");
    expect(result).toContain("1 flow(s)");
    expect(result).toContain("1 loop(s)");
    expect(result).toContain("Order Flow");
    expect(result).toContain("model_inspect");
    expect(result).toContain("codeontic check");
  });

  it("returns empty when model has no loops or flows", async () => {
    await mkdir(join(targetDir, ".codeontic", "model", "loops"), { recursive: true });
    const result = await runHookSessionStart(targetDir);
    expect(result).toBe("");
  });
});
