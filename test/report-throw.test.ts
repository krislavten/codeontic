import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `report` when `runReport` itself throws.
 *
 * Its own file because pinning this needs the module mocked, and the mock is
 * file-wide. Worth the file: this branch is the one place where "the reading
 * did not happen" could still look like "nothing to report" — it used to print
 * a single line and return, skipping both the annotation and the step summary.
 * A green step with an empty summary and no mark on the PR is precisely the
 * state the whole advisory tier is built to avoid, and it was hiding inside the
 * command that announces it.
 */
vi.mock("../src/cli/commands/report.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cli/commands/report.js")>(
    "../src/cli/commands/report.js",
  );
  return {
    ...actual,
    runReport: vi.fn(async () => {
      throw new Error("模型 YAML 解析炸了");
    }),
  };
});

const { run } = await import("../src/cli/run.js");

let dir: string;
let out: string[];
let summaryPath: string;
let previousSummary: string | undefined;

const io = {
  log: (l: string) => out.push(l),
  error: (l: string) => out.push(l),
};

beforeEach(async () => {
  out = [];
  dir = await mkdtemp(join(tmpdir(), "codeontic-report-throw-"));
  summaryPath = join(dir, "summary.md");
  previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
});

afterEach(async () => {
  if (previousSummary === undefined) Reflect.deleteProperty(process.env, "GITHUB_STEP_SUMMARY");
  else process.env.GITHUB_STEP_SUMMARY = previousSummary;
  await rm(dir, { recursive: true, force: true });
});

describe("report — when the run itself throws", () => {
  it("still annotates, still writes a summary, and still exits 0", async () => {
    const code = await run(["report", dir, "--format", "github"], io);
    // Advisory to the end: a crash in a reading does not turn into a red build.
    expect(code).toBe(0);

    const stdout = out.join("\n");
    expect(stdout).toContain("::error title=");
    expect(stdout).toContain("codeontic 报告档没跑完");

    const summary = await readFile(summaryPath, "utf8");
    // The failure travels the normal rendering path, so it lands in the summary
    // as a named section with its own cause…
    expect(summary).toContain("报告未能产出");
    expect(summary).toContain("模型 YAML 解析炸了");
    expect(summary).toContain("空白不代表对账通过");
    // …and the workflow command still does not leak into the summary body.
    expect(summary).not.toContain("::error");
  });
});
