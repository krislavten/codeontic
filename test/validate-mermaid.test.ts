import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModel } from "../src/loader/load-model.js";
import { renderFlowMermaid } from "../src/views/flow-mermaid.js";
import { validateMermaid } from "../src/views/validate-mermaid.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedDir = join(__dirname, "fixtures", "synthetic-model");

// mmdc launches a real puppeteer/Chromium render — slower than the rest
// of the suite's sub-second unit tests.
const MMDC_TIMEOUT = 30_000;

describe("validateMermaid", () => {
  it(
    "reports valid for real mermaid rendered from a real seeded model",
    async () => {
      const { graph } = await loadModel(seedDir);
      const mermaid = renderFlowMermaid(graph, "C9");
      const result = await validateMermaid(mermaid);
      expect(result).toEqual({ status: "valid" });
    },
    MMDC_TIMEOUT,
  );

  it(
    "reports invalid with a syntax error message for broken mermaid text",
    async () => {
      const broken = "flowchart TB\n  A[Start --> B[End\n  not valid mermaid !!! ###";
      const result = await validateMermaid(broken);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        // asserts the actual mmdc parser error surfaced through, not just
        // "some non-empty string" — which wouldn't catch extractErrorMessage
        // accidentally forwarding an unrelated failure (e.g. a spawn error)
        // instead of the real syntax diagnostic.
        expect(result.error).toMatch(/parse error/i);
      }
    },
    MMDC_TIMEOUT,
  );

  it("reports unavailable (without ever invoking a subprocess to fetch anything) when mmdc can't be resolved", async () => {
    const result = await validateMermaid("flowchart TB\n  A --> B", {
      mmdcBinPath: "/definitely/does/not/exist/mmdc.js",
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/@mermaid-js\/mermaid-cli/);
    }
  });

  /**
   * A machine that cannot start Chromium must not be told its diagram is
   * broken. mmdc exits non-zero for both, so the two get conflated unless
   * something separates them — and the wrong half of that conflation sends
   * someone to edit a diagram that was already correct.
   *
   * Real case, hit on this repo's own first CI run: ubuntu-24.04 restricts
   * unprivileged user namespaces via AppArmor, Chromium's sandbox needs them,
   * and every mermaid test reported `invalid`.
   */
  it(
    "reports unavailable, NOT invalid, when the browser cannot launch",
    async () => {
      // A stand-in for mmdc that fails exactly the way a sandbox-blocked
      // Chromium does. Using the real one would need a machine that genuinely
      // cannot launch a browser, which is not something a test can arrange.
      const fakeMmdc = join(__dirname, "fixtures", "fake-mmdc-no-sandbox.mjs");
      const result = await validateMermaid("flowchart TB\n  A --> B", {
        mmdcBinPath: fakeMmdc,
      });
      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toMatch(/could not run one/i);
        expect(result.reason).toMatch(/NOT judged/);
        expect(result.reason).toMatch(/No usable sandbox/); // underlying error still surfaced
      }
    },
    MMDC_TIMEOUT,
  );

  /**
   * The other half of "cannot run a browser": it was never installed. Hit on
   * this repo's CI the moment a pnpm-store cache hit skipped puppeteer's
   * postinstall. Worth its own test because the binary is named
   * `chrome-headless-shell` there — a signature list matching only
   * "Chrome"/"Chromium" sails right past it, which is exactly what happened.
   */
  it(
    "reports unavailable when the browser was never installed, not just when it fails to launch",
    async () => {
      const fakeMmdc = join(__dirname, "fixtures", "fake-mmdc-no-browser.mjs");
      const result = await validateMermaid("flowchart TB\n  A --> B", { mmdcBinPath: fakeMmdc });
      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toMatch(/could not run one/i);
        expect(result.reason).toMatch(/NOT judged/);
        expect(result.reason).toMatch(/chrome-headless-shell/); // the actionable install hint
      }
    },
    MMDC_TIMEOUT,
  );

  it(
    "still reports invalid for a genuine syntax error (the distinction cuts both ways)",
    async () => {
      const fakeMmdc = join(__dirname, "fixtures", "fake-mmdc-parse-error.mjs");
      const result = await validateMermaid("flowchart TB\n  A[", { mmdcBinPath: fakeMmdc });
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.error).toMatch(/Parse error/);
      }
    },
    MMDC_TIMEOUT,
  );
});
