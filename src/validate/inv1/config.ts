import { z } from "zod";
import { CODEONTIC_CONFIG_RELATIVE_PATH, readCodeonticConfig } from "../../config/config-file.js";

/**
 * INV-1 (canonical-writer) enforcement config, per proposal 001 §6 and
 * Proposal 006 A6. Lives in the TARGET repo (Proposal 010 §1.2:
 * `.codeontic/config.json`) so the engine hard-codes NO business paths — it
 * only provides the generic "guarded-column write-site scan + location
 * allowlist" primitive; which tables/columns are guarded and which paths may
 * write them is data supplied here.
 *
 * Shipped as JSON (not the plan's `codeontic.config.ts`) deliberately: T0 must
 * stay <5s and must not compile TypeScript in its hot path, and JSON needs no
 * TS-loader dependency. How config ultimately lands in the target repo (`.ts` vs `.json`,
 * repo location) is a GATE-1 (A8) decision — A6 does not pre-empt it.
 */
export const GuardedTableConfig = z.object({
  /** Guarded state columns (drizzle property names), e.g. ["status"]. */
  columns: z.array(z.string().min(1)).min(1),
  /** Repo-relative path prefixes whose files MAY write these columns (the canonical writer). */
  allowlist: z.array(z.string().min(1)).min(1),
});
export type GuardedTableConfig = z.infer<typeof GuardedTableConfig>;

export const Inv1Config = z.object({
  /** Keyed by the drizzle table identifier as written in code (e.g. `runs`, `sessions`). */
  guardedTables: z.record(z.string(), GuardedTableConfig),
  /** Alias identifier → canonical guarded-table identifier (for `import { runs as runsTable }`). */
  aliases: z.record(z.string(), z.string()).default({}),
  /**
   * Path prefixes where a dynamic-table `update(<expr>).set(...)` is known to be
   * a table-agnostic generic primitive (e.g. `packages/db`), so it is NOT
   * surfaced as unanalyzable. Everything else dynamic outside the allowlist is.
   */
  unanalyzableExceptions: z.array(z.string()).default([]),
});
export type Inv1Config = z.infer<typeof Inv1Config>;

export interface LoadInv1ConfigResult {
  /** Parsed config, or undefined when no config file is present (INV-1 simply not run). */
  config?: Inv1Config;
  /** Set when a config file exists but is malformed — a loud error, not a silent skip. */
  error?: string;
}

/**
 * Proposal 010 §1.2: moved from repo-root `codeontic.config.json` to
 * `.codeontic/config.json` (the unified per-target namespace — model, config,
 * adapter, agent kit, and side-channel all live under one directory).
 */
export const INV1_CONFIG_RELATIVE_PATH = CODEONTIC_CONFIG_RELATIVE_PATH;

/** Loads and validates `<dir>/.codeontic/config.json`. Absent file → `{}` (skip); present+invalid → `{error}`. */
export async function loadInv1Config(dir: string): Promise<LoadInv1ConfigResult> {
  // The file read + JSON parse is shared with every other section of this one
  // config file (see config-file.ts) — INV-1 owns only its own schema.
  const read = await readCodeonticConfig(dir);
  if (read.error) return { error: read.error };
  if (read.json === undefined) return {}; // no config → INV-1 not configured for this target

  const parsed = Inv1Config.safeParse(read.json);
  if (!parsed.success) {
    return {
      error: `${INV1_CONFIG_RELATIVE_PATH} failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  return { config: parsed.data };
}
