import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWN_BUCKET } from "../src/cli/commands/gate-render.js";
import { DRIFT_CHECKS } from "../src/cli/commands/gate.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every check name the engine can produce must be deliberately classified for
 * the gate's guidance: either it means "the model points at code that is not
 * there" (DRIFT_CHECKS), or it has a bucket of its own (OWN_BUCKET), or the
 * catch-all "the model contradicts itself" is genuinely the right advice.
 *
 * This is enforced instead of remembered because getting it wrong is invisible
 * from the code: reusing an existing name compiles, passes, and only shows up
 * as a summary telling someone to fix a file that is perfectly fine. Four of
 * five consecutive review rounds found exactly that.
 */
const CATCH_ALL_IS_CORRECT = new Set([
  // These really do mean the model contradicts itself.
  "schema",
  "id-uniqueness",
  "referential-integrity",
  "graph-acyclic",
  "flow-shape",
  "filename-id",
  "flow-scenario-ignored",
  "anchor-duplicate",
  "freetext-id-ref",
  "loop-mechanism",
]);

describe("gate guidance", () => {
  it("classifies every CheckName the engine defines", async () => {
    const source = await readFile(join(here, "..", "src", "validate", "types.ts"), "utf8");
    const union = source.slice(source.indexOf("export type CheckName"));
    const names = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z0-9-]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(names.length).toBeGreaterThan(10); // the scan really found the union

    const unclassified = names.filter(
      (n) => !DRIFT_CHECKS.has(n) && !OWN_BUCKET.has(n) && !CATCH_ALL_IS_CORRECT.has(n),
    );
    expect(unclassified).toEqual([]);
  });

  it("no name is in two buckets at once — all three pairs, not just two", () => {
    // The first version of this checked DRIFT×OWN and OWN×CATCH_ALL but never
    // DRIFT×CATCH_ALL, so a name listed in both of those (as anchor-symbol and
    // anchor-crux were) satisfied it — which meant removing one of them from
    // DRIFT_CHECKS, undoing a real fix, still left the suite green. A pairwise
    // check that skips a pair is not a pairwise check.
    for (const n of DRIFT_CHECKS) expect([n, OWN_BUCKET.has(n)]).toEqual([n, false]);
    for (const n of DRIFT_CHECKS) expect([n, CATCH_ALL_IS_CORRECT.has(n)]).toEqual([n, false]);
    for (const n of OWN_BUCKET) expect([n, CATCH_ALL_IS_CORRECT.has(n)]).toEqual([n, false]);
  });
});
