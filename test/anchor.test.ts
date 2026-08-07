import { describe, expect, it } from "vitest";
import { anchorFilePath, anchorSymbol, isValidAnchorFormat } from "../src/validate/anchor.js";

describe("isValidAnchorFormat", () => {
  it("accepts file#symbol anchors", () => {
    expect(isValidAnchorFormat("apps/control-worker/src/idle-watcher.ts#IdleWatcher")).toBe(true);
    expect(isValidAnchorFormat("packages/contracts#SessionEventSchema.idle_warning")).toBe(true);
  });

  it("accepts Next.js route groups and dynamic segments — they are ordinary directory names", () => {
    // Rejecting these made every frontend loop in an App Router repo unanchorable:
    // on a real target repo, 16 of 17 poller-carrying files sat in a Next.js route group.
    expect(
      isValidAnchorFormat("apps/agent-hub/app/(portal)/w/_components/use-revival.ts#useRevival"),
    ).toBe(true);
    expect(isValidAnchorFormat("apps/agent-hub/app/(portal)/(agent)/[id]/page.tsx#Page")).toBe(
      true,
    );
    expect(isValidAnchorFormat("apps/web/app/[...slug]/route.ts#GET")).toBe(true);
  });

  it("rejects `..` as a path segment without banning dots inside a filename", () => {
    expect(isValidAnchorFormat("../../../etc/passwd#x")).toBe(false);
    expect(isValidAnchorFormat("apps/../../../etc/passwd#x")).toBe(false);
    expect(isValidAnchorFormat("apps/foo/..#x")).toBe(false); // `..` right before the `#`
    expect(isValidAnchorFormat("..#x")).toBe(false);
    // a filename that merely CONTAINS two dots is legal and must stay legal
    expect(isValidAnchorFormat("packages/foo/src/foo..bar.ts#X")).toBe(true);
  });

  it("accepts db table.column and bare table anchors", () => {
    expect(isValidAnchorFormat("worker_protocol_jobs.payload")).toBe(true);
    expect(isValidAnchorFormat("sandboxes")).toBe(true);
  });

  it("rejects empty and malformed anchors", () => {
    expect(isValidAnchorFormat("")).toBe(false);
    expect(isValidAnchorFormat("#OnlySymbolNoPath")).toBe(false);
    expect(isValidAnchorFormat("Not Valid At All!!")).toBe(false);
  });
});

describe("anchorFilePath", () => {
  it("extracts the file path portion of a file-symbol anchor", () => {
    expect(anchorFilePath("apps/control-worker/src/idle-watcher.ts#IdleWatcher")).toBe(
      "apps/control-worker/src/idle-watcher.ts",
    );
  });

  it("returns undefined for table-style anchors (no file to resolve)", () => {
    expect(anchorFilePath("worker_protocol_jobs.payload")).toBeUndefined();
    expect(anchorFilePath("sandboxes")).toBeUndefined();
  });
});

describe("anchorSymbol", () => {
  it("extracts the symbol portion, including dotted member paths", () => {
    expect(anchorSymbol("apps/w/src/idle-watcher.ts#IdleWatcher")).toBe("IdleWatcher");
    expect(anchorSymbol("packages/contracts#SessionEventSchema.idle_warning")).toBe(
      "SessionEventSchema.idle_warning",
    );
  });

  it("returns undefined for table-style anchors", () => {
    expect(anchorSymbol("worker_protocol_jobs.payload")).toBeUndefined();
  });
});
