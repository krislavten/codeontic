import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CODEONTIC_SKILL } from "../cli/assets/agent-kit.js";
import { type UpsertOutcome, upsertManagedSection } from "./sections.js";

export interface HostTarget {
  id: string;
  relPath: string;
  kind: "section" | "owned";
  mcpConfigRelPath?: string;
  detectPaths: (home: string, repo: string) => string[];
  wrapContent(body: string): string;
}

const HOSTS: HostTarget[] = [
  {
    id: "agents",
    relPath: "AGENTS.md",
    kind: "section",
    detectPaths: (home) => [join(home, ".codex"), join(home, ".config", "opencode")],
    wrapContent: (body) => body,
  },
  {
    id: "cursor",
    relPath: ".cursor/rules/codeontic.mdc",
    kind: "owned",
    mcpConfigRelPath: ".cursor/mcp.json",
    detectPaths: (home, repo) => [join(home, ".cursor"), join(repo, ".cursor")],
    wrapContent: (body) => `---\nalwaysApply: true\n---\n\n${body}\n`,
  },
  {
    id: "gemini",
    relPath: "GEMINI.md",
    kind: "section",
    mcpConfigRelPath: ".gemini/settings.json",
    detectPaths: (home) => [join(home, ".gemini")],
    wrapContent: (body) => body,
  },
  {
    id: "copilot",
    relPath: ".github/copilot-instructions.md",
    kind: "section",
    detectPaths: (_home, repo) => [join(repo, ".github")],
    wrapContent: (body) => body,
  },
];

export function getHost(id: string): HostTarget | undefined {
  return HOSTS.find((h) => h.id === id);
}

export function allHostIds(): string[] {
  return HOSTS.map((h) => h.id);
}

export function instructionBody(): string {
  const content = CODEONTIC_SKILL;
  const first = content.indexOf("---");
  if (first === -1) return content.trim();
  const second = content.indexOf("---", first + 3);
  if (second === -1) return content.trim();
  return content.slice(second + 3).trim();
}

async function pathExists(p: string): Promise<boolean> {
  return access(p)
    .then(() => true)
    .catch(() => false);
}

export interface DetectResult {
  id: string;
  detected: boolean;
}

export async function detectHosts(repoDir: string): Promise<DetectResult[]> {
  const home = homedir();
  const results: DetectResult[] = [];
  for (const host of HOSTS) {
    const paths = host.detectPaths(home, repoDir);
    let detected = false;
    for (const p of paths) {
      if (await pathExists(p)) {
        detected = true;
        break;
      }
    }
    results.push({ id: host.id, detected });
  }
  return results;
}

export type InstructionOutcome = UpsertOutcome | "updated" | "skipped-modified";

export interface WriteHostResult {
  hostId: string;
  instruction: InstructionOutcome;
  mcp?: JsonMergeOutcome | undefined;
}

async function writeInstruction(
  repoDir: string,
  host: HostTarget,
  body: string,
): Promise<InstructionOutcome> {
  const filePath = join(repoDir, host.relPath);
  const content = host.wrapContent(body);

  if (host.kind === "section") {
    const result = await upsertManagedSection(filePath, content);
    return result.outcome;
  }

  // owned: compare before write.
  // ONLY ENOENT means "not there". Swallowing every read error (EACCES,
  // EISDIR, a transient EMFILE) would classify an unreadable-but-present file
  // as absent and then truncate it — the exact data loss this branch exists to
  // prevent, just reached through a different door.
  const existing = await readFile(filePath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  });
  if (existing === content) return "unchanged";
  // An `owned` file whose content differs is NOT overwritten. It used to be —
  // a whole-file `writeFile` reported only as `instruction → updated`, so a
  // hand-edited `.cursor/rules/codeontic.mdc` lost its edits with no prompt
  // and no diff to recover from if the file was never committed. Silently
  // destroying user content is worse than refusing to upgrade one file, and
  // it contradicts the posture B1 already takes one layer over: a managed
  // file without markers is skipped with a migration hint, never rewritten.
  // Recovering is deliberately manual (delete the file and re-run) so the
  // user sees what they are discarding.
  if (existing !== undefined) return "skipped-modified";
  await mkdir(dirname(filePath), { recursive: true });
  // Exclusive create, not a plain write: the check above and this write are
  // two syscalls, so an editor or a concurrent `init` can create the file in
  // between and a truncating write would eat it. `wx` makes the kernel settle
  // it. On EEXIST we lost the race — re-read and answer from what is actually
  // on disk rather than assuming.
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    const raced = await readFile(filePath, "utf8");
    return raced === content ? "unchanged" : "skipped-modified";
  }
  return "created";
}

export type JsonMergeOutcome = "created" | "merged" | "unchanged" | "skipped-unparseable";

export async function mergeMcpServer(
  filePath: string,
  versionPin: string,
): Promise<JsonMergeOutcome> {
  const entry = {
    command: "npx",
    args: ["-y", `codeontic@${versionPin}`, "mcp"],
  };

  let raw: string | undefined;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    // file doesn't exist
  }

  if (raw === undefined) {
    await mkdir(dirname(filePath), { recursive: true });
    const obj = { mcpServers: { codeontic: entry } };
    await writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    return "created";
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "skipped-unparseable";
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return "skipped-unparseable";
  }

  const servers = (obj.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return "skipped-unparseable";
  }

  if (JSON.stringify(servers.codeontic) === JSON.stringify(entry)) {
    return "unchanged";
  }

  servers.codeontic = entry;
  obj.mcpServers = servers;
  await writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return "merged";
}

export async function writeAgentHost(
  repoDir: string,
  hostId: string,
  versionPin: string,
): Promise<WriteHostResult> {
  const host = getHost(hostId);
  if (!host) throw new Error(`unknown host: ${hostId}`);

  const body = instructionBody();
  const instruction = await writeInstruction(repoDir, host, body);

  let mcp: JsonMergeOutcome | undefined;
  if (host.mcpConfigRelPath) {
    mcp = await mergeMcpServer(join(repoDir, host.mcpConfigRelPath), versionPin);
  }

  return { hostId, instruction, mcp };
}
