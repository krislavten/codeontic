import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findYamlFiles, formatModelDirReadError } from "../src/loader/find-yaml-files.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "codeontic-find-yaml-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("findYamlFiles", () => {
  it("finds both .yaml and .yml files, recursively, and ignores non-yaml files", async () => {
    await mkdir(join(workDir, "loops"), { recursive: true });
    await writeFile(join(workDir, "flows.yaml"), "id: C1\n", "utf8");
    await writeFile(join(workDir, "loops", "l1.yml"), "id: L1\n", "utf8");
    await writeFile(join(workDir, "README.md"), "not yaml\n", "utf8");

    const files = (await findYamlFiles(workDir)).map((f) => f.replace(`${workDir}/`, "")).sort();
    expect(files).toEqual(["flows.yaml", "loops/l1.yml"]);
  });

  it("returns [] for an existing, empty directory", async () => {
    expect(await findYamlFiles(workDir)).toEqual([]);
  });

  it("throws a clear, actionable error for a missing directory (ENOENT)", async () => {
    await expect(findYamlFiles(join(workDir, "does-not-exist"))).rejects.toThrow(
      /not found.*codeontic init.*codeontic import/s,
    );
  });

  it("throws a clear error when the path exists but is a file, not a directory (ENOTDIR)", async () => {
    const filePath = join(workDir, "not-a-dir.yaml");
    await writeFile(filePath, "id: L1\n", "utf8");
    await expect(findYamlFiles(filePath)).rejects.toThrow(/is not a directory/);
  });
});

describe("formatModelDirReadError", () => {
  // Direct unit coverage for every errno branch, including EACCES/EPERM —
  // reproducing real permission-denied conditions on a real filesystem is
  // flaky across macOS/Linux/CI (containers frequently run as root, which
  // ignores chmod), so the mapping logic is tested as a pure function
  // instead of through actual fs permission manipulation.
  it("maps ENOENT to a not-found hint pointing at init/import", () => {
    expect(formatModelDirReadError("/x", "ENOENT")).toMatch(
      /not found.*codeontic init.*codeontic import/s,
    );
  });

  it("maps ENOTDIR to a not-a-directory hint", () => {
    expect(formatModelDirReadError("/x", "ENOTDIR")).toMatch(/is not a directory/);
  });

  it("maps EACCES and EPERM to a permission-denied hint", () => {
    expect(formatModelDirReadError("/x", "EACCES")).toMatch(/permission denied/);
    expect(formatModelDirReadError("/x", "EPERM")).toMatch(/permission denied/);
  });

  it("returns undefined for an unrecognized or missing error code, signaling rethrow-as-is", () => {
    expect(formatModelDirReadError("/x", "EMFILE")).toBeUndefined();
    expect(formatModelDirReadError("/x", undefined)).toBeUndefined();
  });
});
