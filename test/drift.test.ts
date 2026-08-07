import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModel } from "../src/loader/load-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const syntheticSeedDir = join(__dirname, "fixtures", "synthetic-model");

/**
 * Design-constraint guard (001 §6 / 006 A6's own governing rule): the T0/
 * default CI path must stay deterministic and offline — no LLM calls, no
 * full-repo rebuilds, no significantly-extended PR latency. Loop discovery
 * (LLM-assisted) is an explicitly SEPARATE, offline authoring step (see
 * docs/prompts/loop-discovery.md) — never part of `codeontic check`'s
 * default path.
 *
 * These checks are necessarily partial, by construction, and are scoped
 * that way on purpose rather than left to look stronger than they are: a
 * regex text scan can't see through indirection (a network call hidden
 * behind a helper function in an unrelated directory, or renamed imports),
 * and an allowlist over `CheckName` only constrains checks that report
 * through the existing Violation.check taxonomy. Real enforcement against a
 * determined attempt to smuggle in an LLM call or a T1-only check belongs
 * to code review, not a regex — these two tests exist to catch the
 * *unintentional* case: an addition to src/validate/ that fetches something
 * or reports an out-of-scope check name without anyone noticing it during
 * the phase it landed in.
 */
describe("design constraint: T0 / default CI path stays deterministic and offline", () => {
  it("no file under src/validate/ contains an LLM/network client call — CI's default path must stay offline and deterministic", async () => {
    const validateDir = join(__dirname, "..", "src", "validate");
    const files = (await readdir(validateDir)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0); // sanity: the glob itself must find something

    const forbidden = /openai|anthropic|chat\.completions|fetch\(|http\.request|https\.request/i;
    for (const file of files) {
      const src = await readFile(join(validateDir, file), "utf8");
      expect(src, `src/validate/${file} appears to call a network/LLM client`).not.toMatch(
        forbidden,
      );
    }
  });

  it("T0's implemented checks are a subset of the cheap/deterministic CheckName values Phase 1 defines", async () => {
    // Allowlist, not a denylist of guessed future names: anything runT0
    // reports that isn't in this list is by definition Phase 1/3 work
    // (INV-1's AST writer-scan, T1's queue-derivation-chain, baseline
    // growth needs a two-snapshot diff runT0 doesn't take) leaking into
    // the single-snapshot T0 path — whatever it ends up being named.
    const t0AllowedChecks = new Set([
      "schema",
      "id-uniqueness",
      "filename-id",
      "referential-integrity",
      "graph-acyclic",
      "anchor-format",
      "anchor-existence",
    ]);
    const { runT0 } = await import("../src/validate/t0.js");
    const { graph, singleNodeFiles } = await loadModel(syntheticSeedDir);
    const result = await runT0(
      { graph, entries: [], parseErrors: [], duplicateIds: [], singleNodeFiles },
      { repoRoot: join(__dirname, "..") }, // include anchor-existence in the exercised set
    );
    const checksRun = new Set(result.violations.map((v) => v.check));
    const outOfScope = [...checksRun].filter((c) => !t0AllowedChecks.has(c));
    expect(outOfScope, "runT0 reported a check outside T0's Phase-0/1 allowlist").toEqual([]);
  });
});
