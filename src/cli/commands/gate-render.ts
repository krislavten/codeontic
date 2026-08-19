import { appendFile } from "node:fs/promises";
import type { Violation } from "../../validate/types.js";
import { CONFIG_CHECK, type GateResult } from "./gate.js";

/**
 * Turning a gate verdict into words. This lives in the engine because the
 * attribution is engine knowledge: which check names exist, which of them mean
 * "the model points at something that is gone" versus "the model contradicts
 * itself", and — the one a consumer cannot get right by scraping — that a
 * non-zero run with no findings at all is a PIPELINE failure, not a model one.
 * A workflow that greps stdout has to hardcode a list of causes, and that list
 * is wrong the moment the engine grows a check.
 */

/** Check names that mean "the model points at code that isn't there (anymore)". */
const DRIFT_CHECKS = new Set(["anchor-existence", "anchor-format"]);

function bullets(violations: Violation[]): string[] {
  return violations.map((v) => {
    const where = v.nodeId ? `\`${v.nodeId}\`` : v.file ? `\`${v.file}\`` : "";
    return `- **${v.check}** ${where} — ${v.message}`;
  });
}

function guidance(violations: Violation[]): string[] {
  const names = new Set(violations.map((v) => v.check));
  const lines: string[] = [];
  if ([...names].some((n) => DRIFT_CHECKS.has(n))) {
    lines.push(
      "模型指向的文件不存在，或锚点写法不合规 —— 同 PR 更新对应节点的 `anchors` / `verified_by`，" +
        "指向文件搬迁后的真实位置。",
    );
  }
  if (names.has(CONFIG_CHECK)) {
    // Its own bucket: the thing to fix is a JSON file, and the model is fine.
    // Folding it into "the model contradicts itself" sends the author reading
    // YAML that has nothing wrong with it.
    lines.push(
      "`.codeontic/config.json` 本身坏了（JSON 语法或 schema 不合法），INV-1 整层因此没跑 —— " +
        "修的是这个配置文件，不是模型。",
    );
  }
  if ([...names].some((n) => !DRIFT_CHECKS.has(n) && n !== CONFIG_CHECK)) {
    lines.push(
      "模型自身不自洽（字段不合法 / id 撞车 / 引用了不存在的节点 / 成环 / shape 与字段矛盾）" +
        " —— 按上面每条的 message 修模型。",
    );
  }
  return lines;
}

/** Human-readable verdict for a terminal. */
export function renderGateText(result: GateResult): string {
  const lines: string[] = [];
  switch (result.verdict) {
    case "clean":
      if (result.baseUnavailableReason) {
        lines.push(
          `gate: passed — nothing wrong at HEAD, but the base was NOT scored (${result.baseUnavailableReason}).`,
          "所以「有没有新增债务」这一项本次没查——它需要两侧对比才算得出来。",
        );
        break;
      }
      lines.push(
        result.scope === "model-only"
          ? "gate: passed — no MODEL errors. (Model-only run: anchor existence and INV-1 did not run, " +
              "so this is not a statement about the code.)"
          : result.advisoryCount > 0
            ? `gate: passed — no blocking errors, but ${result.advisoryCount} advisory finding(s) ran and were not counted.`
            : "gate: passed — no model errors.",
      );
      if (result.scope !== "model-only" && result.advisoryCount > 0) {
        lines.push(
          "锚点存在性等检查默认是 advisory —— 它们发现了问题但不影响判定。要它们参与判红，加 --strict-anchors；" +
            "完整清单跑 `codeontic check`。",
        );
      }
      break;
    case "preexisting":
      lines.push(
        `gate: passed — ${result.errors.length} error(s), all of them already present at the base ref.`,
        "这不是本次改动引入的，所以不挡你；但基线上的模型与代码已经对不上，仍需有人修。",
        ...bullets(result.errors),
      );
      break;
    case "unverifiable-base":
      lines.push(
        result.errors.length === 0
          ? `gate: FAILED — the gate could not run as configured (${result.baseUnavailableReason}). An empty result here means NOT CHECKED, not clean.`
          : `gate: FAILED — ${result.errors.length} error(s), and the base could not be scored ` +
              `(${result.baseUnavailableReason}).`,
        "拿不到基线就无法判断是否本次引入 —— 按判红处理，宁可多挡一次。",
        ...bullets(result.errors),
      );
      break;
    case "new-errors":
      lines.push(
        `gate: FAILED — ${result.newErrors.length} error(s) introduced by this change.`,
        ...bullets(result.newErrors),
        ...guidance(result.newErrors),
      );
      break;
  }
  return lines.join("\n");
}

/** GitHub step-summary markdown. */
export function renderGateMarkdown(result: GateResult): string {
  const out: string[] = ["## codeontic gate", ""];
  switch (result.verdict) {
    case "clean":
      if (result.baseUnavailableReason) {
        out.push(
          `✅ HEAD 本身没有 error，放行。⚠ 但**基线没能打分**（${result.baseUnavailableReason}），`,
          "所以「本次有没有新增债务」没查——那一项要两侧对比才算得出来。",
        );
        break;
      }
      out.push(
        result.scope === "model-only"
          ? "✅ **模型自身**没有 error。⚠ 本次是 model-only 运行：**锚点存在性与 INV-1 没跑**，" +
              "所以这条绿不构成「模型与代码一致」的判断。"
          : result.advisoryCount > 0
            ? `✅ 没有阻断级 error，放行。⚠ 但有 **${result.advisoryCount} 条 advisory 级发现**没参与判定（锚点存在性默认就是 advisory）——**这条绿不等于「模型与代码一致」**。要它们参与判红，加 \`--strict-anchors\`；完整清单跑 \`codeontic check\`。`
            : "✅ 模型与代码一致，没有 error。",
      );
      break;
    case "preexisting":
      out.push(
        `⚠️ **本次改动放行，但基线上的模型是坏的** —— 下面 ${result.errors.length} 条 error 在 base 上**已经存在**，`,
        "不是这次引入的，所以不挡你。但它们仍需有人修：在修好之前，模型给出的读数都要打折看。",
        "",
        ...bullets(result.errors),
      );
      break;
    case "unverifiable-base":
      out.push(
        result.errors.length === 0
          ? `❌ **判红**：门禁没能按配置跑起来（${result.baseUnavailableReason}）。**这里的「零条 error」是「没查」，不是「没问题」** —— 先修管线配置。`
          : `❌ **判红**：${result.errors.length} 条 error，且**无法给基线打分**（${result.baseUnavailableReason}）。`,
        "拿不到基线就无法判断是否本次引入 —— 宁可多挡一次，也不因为读不到 base 就静默放行。",
        "",
        ...bullets(result.errors),
      );
      break;
    case "new-errors":
      out.push(
        `❌ **判红**：本次改动引入了 ${result.newErrors.length} 条 error。`,
        "",
        ...bullets(result.newErrors),
        "",
        ...guidance(result.newErrors).map((g) => `> ${g}`),
      );
      if (result.errors.length > result.newErrors.length) {
        const old = result.errors.length - result.newErrors.length;
        out.push("", `> （另有 ${old} 条 error 在 base 上已存在，未计入本次判定。）`);
      }
      break;
  }
  return `${out.join("\n")}\n`;
}

/**
 * Writes the markdown to `$GITHUB_STEP_SUMMARY` when that is set. Appending
 * (not truncating) is what the file is for — several steps write to the same
 * summary.
 *
 * Never throws. A summary file that is unset, read-only, or on a full disk is a
 * delivery problem for one rendering, and letting it reject would take down the
 * command around it — including the two that promise never to fail. Callers get
 * `false` and print the markdown to stdout instead, so the content survives
 * either way.
 */
export async function writeGithubSummary(markdown: string): Promise<boolean> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return false;
  try {
    await appendFile(target, markdown, "utf8");
    return true;
  } catch {
    return false;
  }
}
