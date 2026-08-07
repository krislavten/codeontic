import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph } from "../src/loader/model-graph.js";
import { affectedNodes, changedFiles, debtIdsAtRef, gitRootOf } from "../src/query/diff.js";
import { runInv1Check } from "../src/validate/inv1/check.js";
import type { Inv1Config } from "../src/validate/inv1/config.js";

describe("affectedNodes — pure diff→model mapping", () => {
  it("flags loops/junctions/scenarios whose anchor file is in the changed set", () => {
    const { graph } = buildGraph([
      {
        file: "a",
        node: {
          id: "L1",
          kind: "loop",
          title: "x",
          boundary: "b",
          owner: "o",
          status: "unverified",
          anchors: ["packages/x/run.ts#Run"],
          consumes_queues: [],
          scenarios: [],
        },
      },
      {
        file: "b",
        node: {
          id: "J-x",
          kind: "junction",
          risk_class: "handoff",
          between: ["L1"],
          scenarios: [],
          status: "unverified",
          evidence: [{ id: "e", kind: "code", anchor: "packages/y/svc.ts#Svc" }],
        },
      },
    ]);
    const changed = ["packages/x/run.ts", "packages/z/other.ts"];
    const affected = affectedNodes(graph, changed);
    expect(affected.map((a) => a.nodeId)).toEqual(["L1"]); // only L1's anchor file changed
    expect(affectedNodes(graph, ["packages/y/svc.ts"]).map((a) => a.nodeId)).toEqual(["J-x"]);
    expect(affectedNodes(graph, ["nothing.ts"])).toEqual([]);
  });
});

describe("git-backed diff helpers", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-diff-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const commit = async (rel: string, content: string, msg: string) => {
    await mkdir(join(repo, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    await writeFile(join(repo, rel), content);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repo });
  };

  it("gitRootOf resolves the repo top-level", async () => {
    expect(await gitRootOf(repo)).toBeTruthy();
    expect(await gitRootOf(await mkdtemp(join(tmpdir(), "nongit-")))).toBeUndefined();
  });

  it("changedFiles returns files changed since merge-base with the base ref", async () => {
    execFileSync("git", ["tag", "base"], { cwd: repo }); // base at root commit
    await commit("src/a.ts", "export const a = 1;", "add a");
    await commit("src/b.ts", "export const b = 2;", "add b");
    const changed = await changedFiles(repo, "base");
    expect(changed?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await changedFiles(repo, "no-such-ref")).toBeUndefined();
  });

  it("debtIdsAtRef reads the model's debt ids at the base ref (before snapshot)", async () => {
    await commit(
      "model/baseline/debt.yaml",
      "- id: DEBT-old-one\n  kind: debt\n  category: other\n  subject: s\n  reality: r\n",
      "seed debt",
    );
    execFileSync("git", ["tag", "base"], { cwd: repo });
    // add a new debt after base
    await commit(
      "model/baseline/debt.yaml",
      "- id: DEBT-old-one\n  kind: debt\n  category: other\n  subject: s\n  reality: r\n- id: DEBT-new-two\n  kind: debt\n  category: other\n  subject: s2\n  reality: r2\n",
      "add debt",
    );
    const before = await debtIdsAtRef(repo, "model", "base");
    expect(before).toEqual(new Set(["DEBT-old-one"])); // only the base-ref debt, not the newly-added one
  });
});

describe("runInv1Check — incremental (onlyFiles) mode", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codeontic-diff-inv1-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    await mkdir(join(repo, "apps"), { recursive: true });
    await writeFile(join(repo, "apps", "a.ts"), 'await db.update(runs).set({ status: "x" });');
    await writeFile(join(repo, "apps", "b.ts"), 'await db.update(runs).set({ status: "y" });');
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("scans only the changed candidate files but still reports the full candidate count", async () => {
    const config: Inv1Config = {
      guardedTables: { runs: { columns: ["status"], allowlist: ["packages/control-plane"] } },
      aliases: {},
      unanalyzableExceptions: [],
    };
    const full = await runInv1Check(repo, config);
    expect(full.filesScanned).toBe(2);

    const incremental = await runInv1Check(repo, config, { onlyFiles: new Set(["apps/a.ts"]) });
    expect(incremental.candidateFiles).toBe(2); // full candidate count still reported
    expect(incremental.filesScanned).toBe(1); // but only the one changed file scanned
    expect(incremental.writePoints).toHaveLength(1);
    expect(incremental.writePoints[0]?.filePath).toBe("apps/a.ts");
  });
});
