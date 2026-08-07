import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MODEL_DIR_READ_HINTS: Record<string, string> = {
  ENOENT: `not found — run "codeontic init" and "codeontic import" first`,
  ENOTDIR: "not a directory — check the target path",
  EACCES: "not readable (permission denied)",
  EPERM: "not readable (permission denied)",
};

/**
 * Pure error-code → message mapping, factored out of findYamlFiles so
 * every branch (ENOENT/ENOTDIR/EACCES/EPERM/unknown) is directly
 * unit-testable without needing to actually reproduce each condition on
 * a real filesystem — reproducing EACCES portably (across macOS/Linux/CI
 * containers, some of which run as root and ignore chmod) is exactly the
 * kind of flaky test this sidesteps. Returns undefined for an
 * unrecognized/missing error code, signaling "rethrow as-is".
 */
export function formatModelDirReadError(dir: string, code: string | undefined): string | undefined {
  const hint = code ? MODEL_DIR_READ_HINTS[code] : undefined;
  return hint ? `model directory "${dir}" is ${hint}` : undefined;
}

/**
 * An unreadable model directory (missing, wrong permissions, or not
 * actually a directory) is a setup error, not "zero nodes". Treating it
 * as an empty model would make `runT0` trivially pass with zero
 * violations — a false "T0 passed" that implies something was checked
 * when nothing was. This surfaces a clear, actionable error instead of
 * whatever raw errno a bare `readdir` would throw.
 *
 * Lives in its own module (not inlined in load-model.ts) because it's
 * reused by src/staleness.ts (computeModelContentHash needs the same
 * "every *.yaml/*.yml file under a model dir" listing to hash) — a
 * second, unrelated caller that has no business depending on
 * `loadModel`'s own orchestration module.
 */
export async function findYamlFiles(dir: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    const message = formatModelDirReadError(dir, (err as NodeJS.ErrnoException).code);
    if (message) throw new Error(message);
    throw err;
  }
  return dirents
    .filter((d) => d.isFile() && /\.ya?ml$/.test(d.name))
    .map((d) => join(d.parentPath ?? d.path, d.name));
}
