import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeHooksIntoSettings } from "../src/hosts/settings.js";

let tmpDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codeontic-settings-test-"));
  settingsPath = join(tmpDir, ".claude", "settings.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("mergeHooksIntoSettings", () => {
  it("creates settings.json with matcher-group hooks when file does not exist", async () => {
    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("created");

    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    // Claude Code schema: event type → matcher groups → nested hooks array
    expect(content.hooks.PostToolUse).toHaveLength(1);
    expect(content.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
    expect(content.hooks.PostToolUse[0].hooks[0].type).toBe("command");
    expect(content.hooks.PostToolUse[0].hooks[0].command).toContain("codeontic hook post-edit");
    // timeout is in seconds (Claude Code's unit), not milliseconds
    expect(content.hooks.PostToolUse[0].hooks[0].timeout).toBeLessThanOrEqual(60);
    expect(content.hooks.SessionStart).toHaveLength(1);
    expect(content.hooks.SessionStart[0].hooks[0].command).toContain(
      "codeontic hook session-start",
    );
  });

  it("merges hooks into existing settings preserving other keys", async () => {
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ theme: "dark", hooks: {} }, null, 2), "utf8");

    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("merged");

    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(content.theme).toBe("dark");
    expect(content.hooks.PostToolUse).toHaveLength(1);
  });

  it("preserves third-party hooks", async () => {
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "other-tool hook", timeout: 5 }],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(existing, null, 2), "utf8");

    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("merged");

    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(content.hooks.PostToolUse).toHaveLength(2);
    expect(content.hooks.PostToolUse[0].hooks[0].command).toBe("other-tool hook");
    expect(content.hooks.PostToolUse[1].hooks[0].command).toContain("codeontic hook post-edit");
  });

  it("preserves a third-party hook sharing a matcher group with codeontic's", async () => {
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              { type: "command", command: "npx codeontic hook post-edit", timeout: 5 },
              { type: "command", command: "other-tool check", timeout: 5 },
            ],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(existing, null, 2), "utf8");

    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("merged");

    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    // the shared group survives with only the third-party command left in it
    expect(content.hooks.PostToolUse).toHaveLength(2);
    expect(content.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(content.hooks.PostToolUse[0].hooks[0].command).toBe("other-tool check");
    expect(content.hooks.PostToolUse[1].hooks[0].command).toContain("codeontic hook post-edit");
  });

  it("is idempotent — second run returns unchanged", async () => {
    await mergeHooksIntoSettings(settingsPath);
    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("unchanged");
  });

  it("replaces old codeontic hook entries on upgrade", async () => {
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "npx codeontic hook post-edit", timeout: 99 }],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(existing, null, 2), "utf8");

    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("merged");

    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    // old group emptied by fingerprint removal is dropped; fresh group appended
    expect(content.hooks.PostToolUse).toHaveLength(1);
    expect(content.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
    expect(content.hooks.PostToolUse[0].hooks[0].timeout).toBe(10);
  });

  it("skips unparseable JSON", async () => {
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, "not json {{{", "utf8");

    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("skipped-unparseable");

    const raw = await readFile(settingsPath, "utf8");
    expect(raw).toBe("not json {{{");
  });

  it("skips non-object JSON", async () => {
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, '"just a string"', "utf8");

    const outcome = await mergeHooksIntoSettings(settingsPath);
    expect(outcome).toBe("skipped-unparseable");
  });
});
