import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MermaidValidationResult =
  | { status: "valid" }
  | { status: "invalid"; error: string }
  | { status: "unavailable"; reason: string };

export interface ValidateMermaidOptions {
  /**
   * Overrides the resolved `mmdc` script path. Test-only seam: lets
   * test/validate-mermaid.test.ts force the "unavailable" branch
   * deterministically (a bogus path) without needing to actually
   * uninstall @mermaid-js/mermaid-cli from this repo's own node_modules.
   */
  mmdcBinPath?: string;
}

const INSTALL_HINT =
  '@mermaid-js/mermaid-cli is not installed — run "pnpm add -D @mermaid-js/mermaid-cli puppeteer" to enable mermaid diagram validation';

/**
 * Signatures of "the browser never started", as opposed to "the diagram is
 * wrong". mmdc exits non-zero either way, so without telling them apart a
 * machine that simply cannot run Chromium gets told its diagram is invalid —
 * and someone goes off editing a diagram that was fine.
 *
 * Two distinct causes, both mundane, both met on this repo's own CI:
 *   - not installed: puppeteer's browser download didn't happen (a cache hit
 *     that skips the postinstall is enough), so there is nothing to launch
 *   - installed but unlaunchable: Ubuntu 23.10+/Debian 13+ restrict the
 *     unprivileged user namespaces Chromium's sandbox needs
 *
 * Matched case-insensitively against a deliberately loose set. The binary has
 * been called `chrome`, `chromium`, and `chrome-headless-shell` across
 * versions, and a signature list that has to be exactly right is one that
 * silently stops working — the failure mode here is mislabeling an environment
 * problem as a content problem, so err toward catching too much.
 */
const BROWSER_LAUNCH_SIGNATURES = [
  "no usable sandbox",
  "failed to launch the browser process",
  "could not find chrome", // covers chrome, chrome-headless-shell
  "could not find chromium",
  "browser was not found",
  "error while loading shared libraries",
  "running as root without --no-sandbox",
  "target closed",
  "protocol error",
];

function looksLikeBrowserLaunchFailure(message: string): boolean {
  const haystack = message.toLowerCase();
  return BROWSER_LAUNCH_SIGNATURES.some((s) => haystack.includes(s));
}

const BROWSER_HINT =
  "mermaid validation needs a working headless Chromium and this machine could not run one. " +
  "Either it isn't installed (`npx puppeteer browsers install chrome-headless-shell`), or it " +
  "cannot launch — on Ubuntu 23.10+/Debian 13+ that is usually AppArmor blocking unprivileged " +
  "user namespaces (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`). " +
  "The diagram itself was NOT judged.";

/**
 * Walks up from `fromFile` looking for the package.json whose `name`
 * matches `packageName`. Needed because @mermaid-js/mermaid-cli's own
 * `exports` map doesn't expose `./package.json` as a resolvable
 * subpath (only `.` is), so `require.resolve("<pkg>/package.json")`
 * throws even when the package is installed — this walks up from a
 * subpath resolution that IS allowed (the package's main entry) instead
 * of relying on an exports-restricted path.
 */
function findPackageRoot(fromFile: string, packageName: string): string | undefined {
  let dir = dirname(fromFile);
  while (true) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === packageName) return dir;
      } catch {
        // malformed package.json at this level — keep climbing, it's not necessarily the package root
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the installed `mmdc` script's absolute path via node module
 * resolution (not `npx`/`PATH` lookup) — deterministic regardless of the
 * caller's cwd or shell PATH, and never reaches the network: if the
 * package isn't resolvable, this returns undefined rather than falling
 * back to fetching it.
 */
function resolveMmdcBin(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve("@mermaid-js/mermaid-cli"); // the "." export — always resolvable if installed
    const pkgRoot = findPackageRoot(entryPath, "@mermaid-js/mermaid-cli");
    if (!pkgRoot) return undefined;
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.mmdc;
    return binRel ? join(pkgRoot, binRel) : undefined;
  } catch {
    return undefined;
  }
}

function extractErrorMessage(err: unknown): string {
  const withStderr = err as { stderr?: string; message?: string };
  const text =
    withStderr.stderr && withStderr.stderr.trim().length > 0
      ? withStderr.stderr
      : withStderr.message;
  return (text ?? String(err)).trim();
}

/**
 * Renders `mermaidText` with mermaid-cli (`mmdc`) to a throwaway SVG and
 * reports whether it actually rendered — the "写出即验证" enforcement
 * from Decision record 004 技术点 5. A generated diagram nobody opens
 * until much later isn't validated, it's just written; this is the
 * module that makes "validated" mean something.
 *
 * Deliberately NOT on codeontic's default `view` CLI path (see
 * src/cli/commands/view.ts): mmdc needs a real puppeteer-launched
 * browser (~300MB Chromium download on first install), which the
 * project's own lightness principle (proposal 001 §6: views generation
 * isn't in the CI gating path) says shouldn't be a hard runtime
 * requirement for every consumer that installs codeontic. It's a
 * devDependency here so codeontic's OWN test suite can prove the
 * generator produces valid mermaid (test/validate-mermaid.test.ts,
 * test/view-cli.test.ts), and available to end users only when they
 * opt in with `codeontic view --validate` AND have separately installed
 * `@mermaid-js/mermaid-cli` themselves.
 */
export async function validateMermaid(
  mermaidText: string,
  options: ValidateMermaidOptions = {},
): Promise<MermaidValidationResult> {
  const bin = options.mmdcBinPath ?? resolveMmdcBin();
  if (!bin || !existsSync(bin)) return { status: "unavailable", reason: INSTALL_HINT };

  const dir = await mkdtemp(join(tmpdir(), "codeontic-mmdc-"));
  try {
    const inputPath = join(dir, "diagram.mmd");
    const outputPath = join(dir, "diagram.svg");
    await writeFile(inputPath, mermaidText, "utf8");

    try {
      await execFileAsync(process.execPath, [bin, "-i", inputPath, "-o", outputPath], {
        timeout: 60_000,
      });
      return { status: "valid" };
    } catch (err) {
      const message = extractErrorMessage(err);
      // "Couldn't run the renderer" is not "your diagram is broken". Reporting
      // the first as the second is the failure mode this tool exists to prevent
      // elsewhere — a confident wrong answer that sends someone to fix the
      // wrong thing. `unavailable` already means "no verdict was reached".
      if (looksLikeBrowserLaunchFailure(message)) {
        return { status: "unavailable", reason: `${BROWSER_HINT}\n\n${message}` };
      }
      return { status: "invalid", error: message };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
