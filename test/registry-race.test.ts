import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The exclusive-create (`wx`) branch of `writeInstruction`, isolated in its own
 * file because reaching it needs `node:fs/promises` mocked.
 *
 * Why it can't live beside the other owned-file tests: pre-creating the target
 * file makes the FIRST `readFile` succeed, so the function returns
 * `skipped-modified` from the existence check and the `wx` write never runs.
 * A test written that way passes even if exclusive creation is reverted to a
 * plain truncating write — it asserts nothing about the race it claims to
 * cover. (Same shape as the fixture bug #35 had to fix: the assertion held for
 * the wrong reason.)
 *
 * So the racer is injected: `readFile` reports ENOENT on the first call (file
 * absent, as the real race begins), and `mkdir` — which runs between the check
 * and the write — creates the file, standing in for the editor or concurrent
 * `init` that wins the race.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: vi.fn(real.readFile),
    mkdir: vi.fn(real.mkdir),
  };
});

const fsp = await import("node:fs/promises");
const { writeAgentHost, getHost } = await import("../src/hosts/registry.js");

const REL = ".cursor/rules/codeontic.mdc";

/** Arms the injection and returns the temp repo dir. */
async function armRace(racerContent: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeontic-race-"));
  const target = join(dir, REL);
  const realRead = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
    .readFile;
  const realMkdir = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
    .mkdir;

  let firstRead = true;
  vi.mocked(fsp.readFile).mockImplementation((async (p: string, ...rest: unknown[]) => {
    if (p === target && firstRead) {
      firstRead = false;
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as typeof fsp.readFile);

  // Runs between the existence check and the exclusive write — this IS the racer.
  vi.mocked(fsp.mkdir).mockImplementation((async (p: string, ...rest: unknown[]) => {
    const out = await (realMkdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    await realMkdir(join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(target, racerContent, "utf8");
    return out;
  }) as unknown as typeof fsp.mkdir);

  return dir;
}

describe("owned host file — exclusive create loses the race safely (EEXIST branch)", () => {
  it("does NOT truncate a file that appeared between the check and the write", async () => {
    const theirs = "written by a concurrent init, mid-flight\n";
    const dir = await armRace(theirs);
    try {
      const result = await writeAgentHost(dir, "cursor", "0.8");
      // Answered from what is actually on disk, not from the stale check.
      expect(result.instruction).toBe("skipped-modified");
      // The assertion that matters: the racer's bytes survived untouched.
      expect(await readFile(join(dir, REL), "utf8")).toBe(theirs);
      // Proves the wx branch really ran: the check said "absent", so without
      // exclusive creation this file would now hold OUR content instead.
      expect(vi.mocked(fsp.mkdir)).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports `unchanged` when the racer wrote byte-identical content", async () => {
    const host = getHost("cursor");
    if (!host) throw new Error("cursor host missing");
    const { instructionBody } = await import("../src/hosts/registry.js");
    const identical = host.wrapContent(instructionBody());
    const dir = await armRace(identical);
    try {
      const result = await writeAgentHost(dir, "cursor", "0.8");
      // Losing the race to someone who wrote exactly what we would have is not
      // a conflict — reporting `skipped-modified` here would send the user off
      // to reconcile a difference that does not exist.
      expect(result.instruction).toBe("unchanged");
      expect(await readFile(join(dir, REL), "utf8")).toBe(identical);
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
