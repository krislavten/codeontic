import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { componentLabel, componentOf, loadComponents } from "../src/config/components.js";

/** A temp target repo whose `.codeontic/config.json` holds `content` (raw string). */
async function targetRepo(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeontic-components-"));
  if (content !== undefined) {
    await mkdir(join(dir, ".codeontic"), { recursive: true });
    await writeFile(join(dir, ".codeontic", "config.json"), content, "utf8");
  }
  return dir;
}

const WEB = { id: "web", label: "User Portal", role: "frontend", paths: ["apps/web"] };
const WORKER = { id: "worker", role: "worker", paths: ["apps/control-worker", "packages/queue"] };

async function withComponents(components: unknown): Promise<string> {
  return targetRepo(JSON.stringify({ guardedTables: {}, components }));
}

describe("loadComponents — presence and absence", () => {
  it("returns nothing when the target has no config file at all", async () => {
    const { components, error } = await loadComponents(await targetRepo());
    expect(error).toBeUndefined();
    expect(components).toBeUndefined();
  });

  it("returns nothing when the config exists but declares no components section", async () => {
    const dir = await targetRepo(JSON.stringify({ guardedTables: {}, aliases: {} }));
    const { components, error } = await loadComponents(dir);
    expect(error).toBeUndefined();
    expect(components).toBeUndefined();
  });

  it("parses declared components, keeping order and optional label", async () => {
    const { components, error } = await loadComponents(await withComponents([WEB, WORKER]));
    expect(error).toBeUndefined();
    expect(components?.map((c) => c.id)).toEqual(["web", "worker"]);
    expect(components?.[0]?.label).toBe("User Portal");
    expect(components?.[1]?.label).toBeUndefined();
  });

  it("reports a malformed config file loudly instead of degrading to 'not configured'", async () => {
    const { components, error } = await loadComponents(await targetRepo("{ not json"));
    expect(components).toBeUndefined();
    expect(error).toMatch(/not valid JSON/);
  });

  it("parses the optional otelService field when present, and leaves it undefined when absent (existing configs keep working unmodified)", async () => {
    const { components, error } = await loadComponents(
      await withComponents([
        { id: "web-app", role: "frontend", paths: ["apps/web"], otelService: "webapp" },
        WORKER, // no otelService — the field predates this repo's own config either way
      ]),
    );
    expect(error).toBeUndefined();
    expect(components?.[0]?.otelService).toBe("webapp");
    expect(components?.[1]?.otelService).toBeUndefined();
  });

  it("rejects an empty-string otelService the same way every other min(1) string field is rejected", async () => {
    const { error } = await loadComponents(
      await withComponents([{ id: "x", role: "worker", paths: ["apps/x"], otelService: "" }]),
    );
    expect(error).toMatch(/failed schema validation/);
  });
});

describe("loadComponents — schema is strict, so a typo cannot pass silently", () => {
  it("rejects an unknown role rather than accepting an unlabelable node", async () => {
    const dir = await withComponents([{ id: "x", role: "backend", paths: ["apps/x"] }]);
    const { components, error } = await loadComponents(dir);
    expect(components).toBeUndefined();
    expect(error).toMatch(/failed schema validation/);
  });

  it("rejects an unknown key — a misspelled `path` must not become a component with no files", async () => {
    const dir = await withComponents([{ id: "x", role: "worker", paths: ["apps/x"], path: "y" }]);
    const { error } = await loadComponents(dir);
    expect(error).toMatch(/failed schema validation/);
  });

  it("rejects a component with no paths", async () => {
    const { error } = await loadComponents(
      await withComponents([{ id: "x", role: "worker", paths: [] }]),
    );
    expect(error).toMatch(/failed schema validation/);
  });

  it("rejects a duplicate id, which would collide two report rows into one", async () => {
    const dir = await withComponents([WEB, { ...WEB, paths: ["apps/other"] }]);
    const { error } = await loadComponents(dir);
    expect(error).toMatch(/duplicate component id "web"/);
  });

  it("rejects a path claimed twice, which would make ownership depend on declaration order", async () => {
    const dir = await withComponents([WEB, { id: "web2", role: "frontend", paths: ["apps/web"] }]);
    const { error } = await loadComponents(dir);
    expect(error).toMatch(/claimed by both "web" and "web2"/);
  });

  it("names a path listed twice by ONE component as the typo it is, not a conflict", async () => {
    const dir = await withComponents([
      { id: "web", role: "frontend", paths: ["apps/web", "./apps/web/"] },
    ]);
    const { error } = await loadComponents(dir);
    expect(error).toMatch(/component "web" lists path "apps\/web" more than once/);
  });

  it("ACCEPTS a nested declaration — the carve-out is the feature, not a conflict", async () => {
    const dir = await withComponents([
      { id: "shared", role: "library", paths: ["packages"] },
      { id: "api", role: "api", paths: ["packages/api"] },
    ]);
    const { components, error } = await loadComponents(dir);
    expect(error).toBeUndefined();
    expect(components?.map((c) => c.id)).toEqual(["shared", "api"]);
  });

  it("rejects a non-array `components` (a `{}` or `null` typo must not pass as 'not configured')", async () => {
    expect((await loadComponents(await withComponents({}))).error).toMatch(
      /failed schema validation/,
    );
    expect((await loadComponents(await withComponents(null))).error).toMatch(
      /failed schema validation/,
    );
  });

  it("rejects non-string path entries and a bare-string `paths`", async () => {
    const wrongElement = await withComponents([
      { id: "x", role: "worker", paths: ["apps/x", 123] },
    ]);
    expect((await loadComponents(wrongElement)).error).toMatch(/failed schema validation/);
    const bareString = await withComponents([{ id: "x", role: "worker", paths: "apps/x" }]);
    expect((await loadComponents(bareString)).error).toMatch(/failed schema validation/);
  });
});

describe("componentOf — path attribution", () => {
  const components = [
    { id: "web", role: "frontend" as const, paths: ["apps/web"] },
    { id: "shared", role: "library" as const, paths: ["packages"] },
    { id: "control-plane", role: "api" as const, paths: ["packages/control-plane"] },
  ];

  it("attributes a file to the component owning its prefix", () => {
    expect(componentOf(components, "apps/web/app/page.tsx")?.id).toBe("web");
  });

  it("lets a nested declaration carve out of a broader one — longest prefix wins", () => {
    expect(componentOf(components, "packages/db/index.ts")?.id).toBe("shared");
    expect(componentOf(components, "packages/control-plane/run/service.ts")?.id).toBe(
      "control-plane",
    );
  });

  it("matches on a segment boundary, so `apps/web` does not swallow `apps/webhooks`", () => {
    expect(componentOf(components, "apps/webhooks/route.ts")).toBeUndefined();
  });

  it("attributes the prefix path itself, not only files under it", () => {
    expect(componentOf(components, "apps/web")?.id).toBe("web");
  });

  it("returns undefined for a file no component claims — unattributed, never guessed", () => {
    expect(componentOf(components, "scripts/release.ts")).toBeUndefined();
  });

  it("normalizes cosmetic path noise on both sides, so it can never silently match nothing", async () => {
    const dir = await withComponents([{ id: "web", role: "frontend", paths: ["  ./apps//web/ "] }]);
    const { components: parsed } = await loadComponents(dir);
    expect(parsed?.[0]?.paths).toEqual(["apps/web"]);
    expect(componentOf(parsed ?? [], "./apps/web/page.tsx")?.id).toBe("web");
    expect(componentOf(parsed ?? [], "apps//web/page.tsx")?.id).toBe("web");
  });

  it("returns undefined when no components are declared at all", () => {
    expect(componentOf([], "apps/web/page.tsx")).toBeUndefined();
  });
});

describe("componentLabel", () => {
  it("prefers the label and falls back to the id", () => {
    expect(
      componentLabel({ id: "web", label: "User Portal", role: "frontend", paths: ["a"] }),
    ).toBe("User Portal");
    expect(componentLabel({ id: "web", role: "frontend", paths: ["a"] })).toBe("web");
  });
});
