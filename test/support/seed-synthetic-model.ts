import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Test-only helper: copies the synthetic model fixture
 * (`test/fixtures/synthetic-model/`) into `<targetDir>/.codeontic/model`
 * (Proposal 010 §1.2 unified namespace). Engine tests that need a REAL,
 * schema-valid, multi-node-kind model on disk (as opposed to hand-built
 * in-memory graphs) use this instead of a target-repo-specific seed — this
 * repo carries no target-repo-specific fixture data (Proposal 010: no
 * adapter, no seed model ships with the engine).
 */
export async function seedSyntheticModel(targetDir: string): Promise<string> {
  const seedRoot = join(__dirname, "..", "fixtures", "synthetic-model");
  const destination = join(targetDir, ".codeontic", "model");
  await cp(seedRoot, destination, { recursive: true });
  return destination;
}
