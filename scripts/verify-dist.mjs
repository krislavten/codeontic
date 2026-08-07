#!/usr/bin/env node
/**
 * Publish-time gate: refuse to ship a `dist/` that wouldn't run.
 *
 * `npm publish` packs whatever is on disk. The failure this guards against is
 * not a loud one — it is a build that reports success and produces nothing, so
 * the tarball is empty and every command in the release flow stays green. That
 * happened once (tsc's `incremental` build info outliving the `dist` it
 * describes, so tsc concluded there was nothing to emit). `tsconfig.build.json`
 * fixes that root cause by keeping the two in one directory; this script is the
 * backstop for the same SHAPE of failure arriving some other way.
 *
 * It checks that the package's actual entry points exist and are non-trivial,
 * rather than counting files — a count passes just as happily on a `dist/` full
 * of the wrong thing.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Defaults to this repo; takes a root argument so the checks can be exercised
// against a fixture rather than only against whatever happens to be on disk
// here — a guard nobody can test is one nobody knows still works.
const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** Every path package.json promises a consumer they can execute or import. */
const entryPoints = [
  ...Object.values(pkg.bin ?? {}),
  ...(pkg.main ? [pkg.main] : []),
  ...(pkg.types ? [pkg.types] : []),
];

if (entryPoints.length === 0) {
  console.error("verify-dist: package.json declares no bin/main/types to verify");
  process.exit(1);
}

const problems = [];
for (const rel of entryPoints) {
  const abs = join(root, rel);
  let info;
  try {
    info = await stat(abs);
  } catch {
    problems.push(`${rel} — declared in package.json but missing from disk`);
    continue;
  }
  if (!info.isFile()) {
    problems.push(`${rel} — exists but is not a file`);
  } else if (info.size === 0) {
    problems.push(`${rel} — exists but is empty`);
  }
}

// A CLI whose entry parses but exports nothing useful still "exists". Cheapest
// meaningful signal that this is real compiled output: the shebang the build is
// expected to carry through from src.
const cli = pkg.bin?.codeontic;
if (cli && !problems.some((p) => p.startsWith(cli))) {
  const head = (await readFile(join(root, cli), "utf8")).slice(0, 200);
  if (!head.includes("#!")) {
    problems.push(`${cli} — no shebang; this does not look like the built CLI entry`);
  }
}

if (problems.length > 0) {
  console.error("verify-dist: refusing to publish — dist/ is not a usable build:");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\nRun `pnpm run build:clean` and try again.");
  process.exit(1);
}

console.log(
  `verify-dist: ok — ${entryPoints.length} declared entry point(s) present and non-empty`,
);
