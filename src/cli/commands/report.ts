import { appendFile } from "node:fs/promises";
import type { CliIO } from "../run.js";

/**
 * `codeontic report` — the advisory half of a CI run, as one command.
 *
 * A workflow used to spell this out as three invocations plus the prose that
 * explains how to read them, all inside one heredoc, and got the framing wrong
 * in a way only the engine can prevent: `coverage`'s `scenario✓` means "a
 * scenario is attached", not "a test backs it", so a report that shows coverage
 * without conformance reads as *more* covered than the model actually is. That
 * ordering and that caveat belong with the numbers, not in each adopter's YAML.
 *
 * Never fails: every section here is a reading, and readings that block are
 * readings people learn to route around. The gate is a separate command.
 */

/** How each section is produced — injected so this module doesn't import the dispatcher it lives under. */
export type Invoke = (args: string[], io: CliIO) => Promise<number>;

export interface ReportSection {
  title: string;
  /** Why this section is here / how to read it, printed above the block. */
  note?: string;
  lines: string[];
  exitCode: number;
}

export interface ReportOptions {
  repoRoot?: string | undefined;
  adapterPath?: string | undefined;
  noCache?: boolean | undefined;
}

export interface ReportResult {
  sections: ReportSection[];
  /** True when a section's command reported it could not run (adapter missing, etc.). */
  degraded: boolean;
}

export async function runReport(
  targetDir: string,
  options: ReportOptions,
  invoke: Invoke,
): Promise<ReportResult> {
  const common: string[] = [];
  if (options.repoRoot) common.push("--repo-root", options.repoRoot);
  if (options.adapterPath) common.push("--adapter-path", options.adapterPath);

  const specs: { title: string; note?: string; args: string[] }[] = [
    {
      title: "实现事实对账（代码里有、模型里没有）",
      note: "方向是 code→model：仓库里的队列/轮询有多少已登记进模型。读数天然偏高，别把它读成「模型覆盖了整个仓库」。",
      args: ["reconcile", targetDir, ...common, ...(options.noCache ? ["--no-cache"] : [])],
    },
    {
      title: "模型侧覆盖（模型自己被锚点/场景绑住了多少）",
      note: "方向与上一节相反：model→code。两者量的不是一回事，要一起看。",
      args: ["coverage", targetDir],
    },
    {
      title: "达标判定（哪些节点的场景真有测试撑着）",
      note: "必须和覆盖一起读：`coverage` 的 `scenario✓` 只表示「挂了场景」，挂的场景 `verified_by` 为空它照样打✓。只有 conformance 会把「有场景但没测试」判成 partial 并点名——少了这一节，一个刻意留空 verified_by 用来暴露疑点的场景，在报告里反而显示成已覆盖。",
      args: ["conformance", targetDir, ...common],
    },
  ];

  const sections: ReportSection[] = [];
  let degraded = false;
  for (const spec of specs) {
    const lines: string[] = [];
    const io: CliIO = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
    const exitCode = await invoke(spec.args, io);
    if (
      exitCode !== 0 ||
      lines.some((l) => l.includes("skipped") || l.includes("failed to load"))
    ) {
      degraded = true;
    }
    sections.push({
      title: spec.title,
      ...(spec.note ? { note: spec.note } : {}),
      lines,
      exitCode,
    });
  }
  return { sections, degraded };
}

export function renderReportMarkdown(result: ReportResult): string {
  const out: string[] = ["## codeontic 报告档（advisory — 不阻断）", ""];
  for (const section of result.sections) {
    out.push(`### ${section.title}`, "");
    if (section.note) out.push(`> ${section.note}`, "");
    out.push("```", ...section.lines, "```", "");
  }
  if (result.degraded) {
    out.push(
      "> ⚠ 有小节没能正常产出（适配器未加载 / 被跳过）。**这是管线故障，不是「没查出问题」**——",
      "> 这一节的空白不代表对账通过。",
      "",
    );
  }
  out.push("> 以上仅供数据采集与人工复核，不影响合并。阻塞判定在 `codeontic gate`，是另一条通道。");
  return `${out.join("\n")}\n`;
}

export function renderReportText(result: ReportResult): string {
  const out: string[] = [];
  for (const section of result.sections) {
    out.push(`── ${section.title}`, ...section.lines, "");
  }
  if (result.degraded) {
    out.push("⚠ 有小节没能正常产出（适配器未加载 / 被跳过）——空白不等于通过。");
  }
  return out.join("\n");
}

export async function appendGithubSummary(markdown: string): Promise<boolean> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return false;
  await appendFile(target, markdown, "utf8");
  return true;
}
