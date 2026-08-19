import { appendFile } from "node:fs/promises";
import type { Violation } from "../../validate/types.js";
import { CONFIG_CHECK, COVERAGE_CHECK, DRIFT_CHECKS, type GateResult } from "./gate.js";

/**
 * Turning a gate verdict into words. This lives in the engine because the
 * attribution is engine knowledge: which check names exist, which of them mean
 * "the model points at something that is gone" versus "the model contradicts
 * itself", and — the one a consumer cannot get right by scraping — that a
 * non-zero run with no findings at all is a PIPELINE failure, not a model one.
 * A workflow that greps stdout has to hardcode a list of causes, and that list
 * is wrong the moment the engine grows a check.
 */

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
      "模型指向的东西不存在（文件没了 / 符号改名 / 引用的文本改了），或锚点写法不合规 —— " +
        "同 PR 更新对应节点的 `anchors` / `verified_by`，指向它们现在真实的位置。",
    );
  }
  if (names.has("baseline-growth")) {
    // Its own bucket: nothing about the model is malformed, a debt node was
    // ADDED. Falling through to the catch-all told the author to fix a schema
    // error / id collision / cycle that does not exist.
    lines.push(
      "本次改动**新增了债务节点**（baseline 只允许减少，不允许增长）—— 要么把这笔债直接还掉，" +
        "要么在 PR 里说明为什么它必须先被登记；不是模型写错了。",
    );
  }
  if (names.has(COVERAGE_CHECK)) {
    // Neither "the model is malformed" nor "the config is malformed": a layer
    // that used to run does not run any more. Sharing either of those buckets
    // sent the author to debug YAML syntax or JSON syntax in a file that this
    // change had simply deleted.
    lines.push(
      "**这次改动让某一层检查不再运行了**（配置或模型被删除）—— 它在 base 上是跑着的。" +
        "把删掉的东西恢复回来，或者在 PR 里说明这个仓库为什么不再需要这一层。",
    );
  }
  if (names.has("inv1-write-site")) {
    // The model is not the thing to change here: a guarded column is written
    // from outside its canonical writer. Routing this to "fix the model" sends
    // the author to edit YAML that correctly describes what the code does.
    lines.push(
      "有代码在**规范写点之外**写了受保护的状态列 —— 要改的是那处写点（挪回规范写点，" +
        "或在 `.codeontic/config.json` 的 allowlist 里说明它为什么也是规范的），不是模型。",
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
  // Checks that already got a bucket of their own above — each names a
  // different thing to fix, and none of them is "the model is malformed".
  const OWN_BUCKET = new Set<string>([
    CONFIG_CHECK,
    COVERAGE_CHECK,
    "baseline-growth",
    "inv1-write-site",
  ]);
  if ([...names].some((n) => !DRIFT_CHECKS.has(n) && !OWN_BUCKET.has(n))) {
    lines.push(
      "模型自身不自洽（字段不合法 / id 撞车 / 引用了不存在的节点 / 成环 / shape 与字段矛盾）" +
        " —— 按上面每条的 message 修模型。",
    );
  }
  return lines;
}

/**
 * Everything true about this run that the verdict line alone does not say.
 *
 * Written once and appended to EVERY verdict, because the previous shape put
 * these only under `clean`: a `new-errors` run in model-only scope never
 * mentioned that anchors and INV-1 had not run at all, and a `preexisting` run
 * on a PR that deleted an anchored file said only "the baseline is broken".
 * A caveat that applies to four verdicts and is printed under one is a caveat
 * that goes unread exactly when it matters.
 */
function caveats(result: GateResult): string[] {
  const out: string[] = [];
  if (result.scope === "model-only") {
    out.push("⚠ 本次是 model-only 运行：**锚点存在性与 INV-1 没跑**，所以这条判定不涉及代码。");
  } else if (result.advisoryCount > 0) {
    out.push(
      `⚠ 另有 **${result.advisoryCount} 处模型指向的东西找不到**（文件不在、符号已改名，或引用的测试标题/文本已改）——锚点这一层默认是 advisory，没参与判定。文件缺失可以用 \`--strict-anchors\` 提成判红；符号与文本这两类按设计永远只报不挡。`,
    );
  }
  if (result.baseUnavailableReason && result.verdict !== "unverifiable-base") {
    out.push(
      `⚠ 基线没能打分（${result.baseUnavailableReason}），所以「本次有没有新增债务」没查——那一项要两侧对比才算得出来。`,
    );
  }
  return out;
}

/** Human-readable verdict for a terminal. */
export function renderGateText(result: GateResult): string {
  const lines: string[] = [];
  switch (result.verdict) {
    case "clean":
      // Every caveat that applies is stated. An earlier shape returned early on
      // an unscorable base, which silently dropped the advisory notice — so on
      // a shallow CI clone (no merge-base) with a model pointing at a deleted
      // file, the summary said only "nothing wrong at HEAD". Two independent
      // things were not checked; saying one of them is not better than saying
      // neither, it is just harder to notice.
      lines.push(
        result.scope === "model-only"
          ? "gate: passed — no MODEL errors."
          : result.advisoryCount > 0
            ? "gate: passed — no blocking errors."
            : "gate: passed — no model errors.",
      );
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
        result.comparedToBase
          ? `gate: FAILED — ${result.newErrors.length} error(s) introduced by this change.`
          : `gate: FAILED — ${result.newErrors.length} error(s). No --base was given, so these are ALL errors at HEAD, not necessarily ones this change introduced.`,
        ...bullets(result.newErrors),
        ...guidance(result.newErrors),
      );
      break;
  }
  lines.push(...caveats(result));
  return lines.join("\n");
}

/** GitHub step-summary markdown. */
export function renderGateMarkdown(result: GateResult): string {
  const out: string[] = ["## codeontic gate", ""];
  switch (result.verdict) {
    case "clean":
      out.push(
        result.scope === "model-only" || result.advisoryCount > 0
          ? "✅ 没有阻断级 error，放行。**但这条绿不等于「模型与代码一致」**，原因见下。"
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
        result.comparedToBase
          ? `❌ **判红**：本次改动引入了 ${result.newErrors.length} 条 error。`
          : `❌ **判红**：${result.newErrors.length} 条 error。**本次没有给 \`--base\`，所以这是 HEAD 上的全部 error，不一定是这次改动引入的。**`,
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
  const notes = caveats(result);
  if (notes.length > 0) out.push("", ...notes.map((n) => `> ${n}`));
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
