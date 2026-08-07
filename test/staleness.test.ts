import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeModelContentHash,
  computeStalenessStamp,
  formatStalenessBanner,
  isStale,
  parseStalenessBanner,
} from "../src/staleness.js";

const execFileAsync = promisify(execFile);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-staleness-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("computeModelContentHash", () => {
  it("changes when a model file's content changes", async () => {
    const modelDir = join(workDir, "model");
    await mkdir(join(modelDir, "loops"), { recursive: true });
    await writeFile(join(modelDir, "loops", "l1.yaml"), "id: L1\n", "utf8");

    const before = await computeModelContentHash(modelDir);
    await writeFile(join(modelDir, "loops", "l1.yaml"), "id: L1\ntitle: changed\n", "utf8");
    const after = await computeModelContentHash(modelDir);

    expect(before).not.toBe(after);
  });

  it("is independent of directory listing order (sorted before hashing)", async () => {
    const modelA = join(workDir, "a", "model");
    const modelB = join(workDir, "b", "model");
    await mkdir(join(modelA, "loops"), { recursive: true });
    await mkdir(join(modelB, "loops"), { recursive: true });
    // write in reverse order between the two dirs
    await writeFile(join(modelA, "loops", "z.yaml"), "id: Z\n", "utf8");
    await writeFile(join(modelA, "loops", "a.yaml"), "id: A\n", "utf8");
    await writeFile(join(modelB, "loops", "a.yaml"), "id: A\n", "utf8");
    await writeFile(join(modelB, "loops", "z.yaml"), "id: Z\n", "utf8");

    expect(await computeModelContentHash(modelA)).toBe(await computeModelContentHash(modelB));
  });

  it("changes when a file is added, even with unchanged existing content", async () => {
    const modelDir = join(workDir, "model");
    await mkdir(join(modelDir, "loops"), { recursive: true });
    await writeFile(join(modelDir, "loops", "l1.yaml"), "id: L1\n", "utf8");
    const before = await computeModelContentHash(modelDir);

    await writeFile(join(modelDir, "loops", "l2.yaml"), "id: L2\n", "utf8");
    const after = await computeModelContentHash(modelDir);

    expect(before).not.toBe(after);
  });
});

describe("computeStalenessStamp", () => {
  it("reports null head/dirty for a directory with no git repo", async () => {
    const modelDir = join(workDir, "model");
    await mkdir(modelDir, { recursive: true });
    const stamp = await computeStalenessStamp(modelDir, workDir);
    expect(stamp.repoHead).toBeNull();
    expect(stamp.repoDirty).toBeNull();
    expect(stamp.modelContentHash).toEqual(expect.any(String));
    expect(stamp.generatedAt).toEqual(expect.any(String));
  });

  it("reports a real commit sha and dirty:false right after a commit, dirty:true after an uncommitted edit", async () => {
    const modelDir = join(workDir, "model", "loops");
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, "l1.yaml"), "id: L1\n", "utf8");

    await execFileAsync("git", ["init"], { cwd: workDir });
    // Identity set locally rather than inherited: a machine with no global
    // git config (a CI runner, a fresh container) can't commit at all, and the
    // test would be reporting on the environment instead of on
    // computeStalenessStamp. The other git-backed suites here already do this.
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: workDir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: workDir });
    await execFileAsync("git", ["add", "-A"], { cwd: workDir });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: workDir });

    const clean = await computeStalenessStamp(join(workDir, "model"), workDir);
    expect(clean.repoHead).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.repoDirty).toBe(false);

    await writeFile(join(modelDir, "l1.yaml"), "id: L1\ntitle: dirty edit\n", "utf8");
    const dirty = await computeStalenessStamp(join(workDir, "model"), workDir);
    expect(dirty.repoHead).toBe(clean.repoHead); // HEAD unchanged, only working tree
    expect(dirty.repoDirty).toBe(true);
  });
});

describe("formatStalenessBanner / parseStalenessBanner round-trip", () => {
  it("recovers every field after formatting", () => {
    const stamp = {
      generatedAt: "2026-07-19T00:00:00.000Z",
      modelContentHash: "abc123",
      repoHead: "deadbeef".repeat(5),
      repoDirty: true,
    };
    const banner = formatStalenessBanner(stamp);
    expect(banner.startsWith("<!--")).toBe(true);
    expect(banner.trimEnd().endsWith("-->")).toBe(true);
    expect(parseStalenessBanner(banner)).toEqual(stamp);
  });

  it("round-trips null repoHead/repoDirty (non-git export) as null, not the literal placeholder text", () => {
    const stamp = {
      generatedAt: "2026-07-19T00:00:00.000Z",
      modelContentHash: "abc123",
      repoHead: null,
      repoDirty: null,
    };
    const banner = formatStalenessBanner(stamp);
    expect(parseStalenessBanner(banner)).toEqual(stamp);
  });

  it("returns undefined for text with no banner", () => {
    expect(parseStalenessBanner("# just a markdown file\nno banner here\n")).toBeUndefined();
  });

  it("ignores a prose line that happens to contain a ': ' substring resembling a field, instead of misreading it as one", () => {
    const stamp = {
      generatedAt: "2026-07-19T00:00:00.000Z",
      modelContentHash: "abc123",
      repoHead: "deadbeef".repeat(5),
      repoDirty: false,
    };
    const bannerWithDecoyProse = [
      "<!-- codeontic-staleness-stamp",
      "Note: this line looks like a field but its key isn't in BANNER_FIELD_KEYS.",
      `generated_at: ${stamp.generatedAt}`,
      `model_content_hash: ${stamp.modelContentHash}`,
      `repo_head: ${stamp.repoHead}`,
      `repo_dirty: ${stamp.repoDirty}`,
      "-->",
    ].join("\n");
    expect(parseStalenessBanner(bannerWithDecoyProse)).toEqual(stamp);
  });
});

describe("isStale", () => {
  it("is false when modelContentHash is unchanged, even if generatedAt/repoHead differ", () => {
    const generated = {
      generatedAt: "2026-07-18T00:00:00.000Z",
      modelContentHash: "same-hash",
      repoHead: "aaa",
      repoDirty: false,
    };
    const current = {
      generatedAt: "2026-07-19T12:00:00.000Z", // a day later
      modelContentHash: "same-hash",
      repoHead: "bbb", // repo advanced, but model content didn't change
      repoDirty: true,
    };
    expect(isStale(generated, current)).toBe(false);
  });

  it("is true when modelContentHash differs", () => {
    const generated = {
      generatedAt: "2026-07-18T00:00:00.000Z",
      modelContentHash: "hash-a",
      repoHead: "aaa",
      repoDirty: false,
    };
    const current = { ...generated, modelContentHash: "hash-b" };
    expect(isStale(generated, current)).toBe(true);
  });
});
