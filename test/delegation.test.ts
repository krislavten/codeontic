import { describe, expect, it } from "vitest";
import { type ReadRepoFile, resolveDelegation } from "../src/validate/delegation.js";

/**
 * The shape these tests are about is the one a god-file split leaves behind:
 * the entry point survives, the behaviour moves, and every anchor stays green.
 */
const FACADE = "apps/worker/src/orchestration/index.ts";

const FACADE_SRC = `
import { SandboxLifecycleService } from "./sandbox/sandbox-lifecycle-service.js";

export class OrchestrationService {
  private sandbox: SandboxLifecycleService;

  private startSandboxKeepAlive(agentId: string): ReturnType<typeof setInterval> {
    return this.sandbox.startSandboxKeepAlive(agentId);
  }
}
`;

const read = (files: Record<string, string>): ReadRepoFile => {
  return (p) => files[p] ?? null;
};

describe("resolveDelegation", () => {
  it("follows this.<field>.<method>() to the file the collaborator is imported from", () => {
    const target = resolveDelegation(
      FACADE,
      FACADE_SRC,
      "startSandboxKeepAlive",
      read({ "apps/worker/src/orchestration/sandbox/sandbox-lifecycle-service.ts": "// impl" }),
    );
    expect(target).toEqual({
      filePath: "apps/worker/src/orchestration/sandbox/sandbox-lifecycle-service.ts",
      symbol: "startSandboxKeepAlive",
    });
  });

  it("rewrites an ESM `.js` specifier to the `.ts` that is actually on disk", () => {
    // The import says "./sandbox/sandbox-lifecycle-service.js"; only the .ts exists.
    const target = resolveDelegation(
      FACADE,
      FACADE_SRC,
      "startSandboxKeepAlive",
      read({ "apps/worker/src/orchestration/sandbox/sandbox-lifecycle-service.ts": "" }),
    );
    expect(target?.filePath.endsWith(".ts")).toBe(true);
  });

  it("resolves a constructor parameter property, not just a field declaration", () => {
    const src = `
      import { Timers } from "./timers.js";
      export class S {
        constructor(private readonly timers: Timers) {}
        startTick() { return this.timers.startTick(); }
      }`;
    const target = resolveDelegation("a/s.ts", src, "startTick", read({ "a/timers.ts": "" }));
    expect(target).toEqual({ filePath: "a/timers.ts", symbol: "startTick" });
  });

  it("follows a bare-identifier receiver too (module-level collaborator)", () => {
    const src = `
      import { timers } from "./timers.js";
      export function startTick() { return timers.startTick(); }`;
    const target = resolveDelegation("a/s.ts", src, "startTick", read({ "a/timers.ts": "" }));
    expect(target).toEqual({ filePath: "a/timers.ts", symbol: "startTick" });
  });

  it("declines a body that does more than hand off — that is code, not a wrapper", () => {
    const src = `
      import { Timers } from "./timers.js";
      export class S {
        constructor(private timers: Timers) {}
        startTick() {
          this.log("starting");
          return this.timers.startTick();
        }
      }`;
    expect(
      resolveDelegation("a/s.ts", src, "startTick", read({ "a/timers.ts": "" })),
    ).toBeUndefined();
  });

  it("declines a package import — a workspace boundary is not ours to cross", () => {
    const src = `
      import { Timers } from "@scope/timers";
      export class S {
        constructor(private timers: Timers) {}
        startTick() { return this.timers.startTick(); }
      }`;
    expect(resolveDelegation("a/s.ts", src, "startTick", read({}))).toBeUndefined();
  });

  it("declines when the target file does not exist — no guessing", () => {
    expect(
      resolveDelegation(FACADE, FACADE_SRC, "startSandboxKeepAlive", read({})),
    ).toBeUndefined();
  });

  it("declines an unknown symbol", () => {
    expect(resolveDelegation(FACADE, FACADE_SRC, "nothingHere", read({}))).toBeUndefined();
  });
});
