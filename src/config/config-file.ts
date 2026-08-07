import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The ONE per-target config file (Proposal 010 §1.2 — the unified
 * `.codeontic/` namespace: model, config, adapter, agent kit and side-channel
 * all live under one directory).
 *
 * It is deliberately one file with several independent top-level sections
 * (`guardedTables`/`aliases`/… for INV-1, `components` for the target's
 * process map) rather than one file per feature: a target repo maintains a
 * single place, and each consumer parses only the section it owns. That means
 * the READ must be shared — two readers of the same path with two copies of
 * "absent → skip, malformed → loud error" is exactly the kind of duplicated
 * derived judgement that drifts (CONTRIBUTING: 派生判断只定义一处).
 */
export const CODEONTIC_CONFIG_RELATIVE_PATH = join(".codeontic", "config.json");

export interface ReadConfigResult {
  /** Parsed JSON, or undefined when the file is simply absent. */
  json?: unknown;
  /** Set when the file exists but is not parseable — a loud error, never a silent skip. */
  error?: string;
}

/**
 * Reads and JSON-parses `<dir>/.codeontic/config.json`.
 *
 * Absent file → `{}` (the feature is just not configured for this target).
 * Present but unparseable → `{ error }`. The two are held apart on purpose:
 * "no config" is a normal state, "config you meant to write but broke" must
 * never degrade into it.
 */
export async function readCodeonticConfig(dir: string): Promise<ReadConfigResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, CODEONTIC_CONFIG_RELATIVE_PATH), "utf8");
  } catch {
    return {};
  }
  try {
    return { json: JSON.parse(raw) };
  } catch (err) {
    return {
      error: `${CODEONTIC_CONFIG_RELATIVE_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
