import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FINGERPRINT = "codeontic hook";

/**
 * Claude Code settings.json hook shapes: each event type holds MATCHER GROUPS,
 * each group holding the actual command hooks — not flat command entries.
 * `timeout` is in SECONDS (Claude Code's unit), not milliseconds.
 */
interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}

const CODEONTIC_HOOKS: [string, MatcherGroup][] = [
  [
    "PostToolUse",
    {
      matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: "npx codeontic hook post-edit", timeout: 10 }],
    },
  ],
  [
    "SessionStart",
    {
      hooks: [{ type: "command", command: "npx codeontic hook session-start", timeout: 8 }],
    },
  ],
];

export type SettingsMergeOutcome = "created" | "merged" | "unchanged" | "skipped-unparseable";

/**
 * Merge codeontic hook entries into a Claude Code `settings.json`.
 *
 * Strategy (adopted from Graft's settings-merge.ts): fingerprint-based
 * delete-then-append. Any existing command whose text contains
 * "codeontic hook" is removed (and a matcher group emptied by that removal
 * is dropped), then the current groups are appended — naturally idempotent
 * and upgradeable. Third-party hooks are never touched. Unparseable JSON is
 * never rewritten.
 */
export async function mergeHooksIntoSettings(settingsPath: string): Promise<SettingsMergeOutcome> {
  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    // file doesn't exist
  }

  if (raw === undefined) {
    await mkdir(dirname(settingsPath), { recursive: true });
    const settings: Record<string, unknown> = {
      hooks: Object.fromEntries(CODEONTIC_HOOKS.map(([type, group]) => [type, [group]])),
    };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return "created";
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "skipped-unparseable";
  }

  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return "skipped-unparseable";
  }

  const hooks = (settings.hooks ?? {}) as Record<string, MatcherGroup[]>;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return "skipped-unparseable";
  }

  let changed = false;
  for (const [type, newGroup] of CODEONTIC_HOOKS) {
    const existing: MatcherGroup[] = Array.isArray(hooks[type]) ? hooks[type] : [];
    const filtered = existing
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group.hooks)
          ? group.hooks.filter((h) => !h.command?.includes(FINGERPRINT))
          : [],
      }))
      .filter((group) => group.hooks.length > 0);
    const updated = [...filtered, newGroup];

    if (JSON.stringify(existing) !== JSON.stringify(updated)) {
      changed = true;
    }
    hooks[type] = updated;
  }

  if (!changed) return "unchanged";

  settings.hooks = hooks;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return "merged";
}
