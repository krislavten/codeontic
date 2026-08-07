---
title: "Proposal 013: NanoNets/Graft 调研与吸收实施计划"
date: 2026-07-29
status: Draft（待评审；实施顺序见 §5，不打断 012 ⑤ 主线）
provenance:
  - NanoNets/Graft @ e2b758b31c20c49a2ba1ac70500fa5c4ab538ac9（2026-07-28, v0.8.0, MIT License）——源码全量精读，非仅 README
related:
  - docs/proposals/001-codeontic-bootstrap.md（零 LLM 红线 §0.7、MCP side-channel §4.2）
  - docs/proposals/004-external-survey-decisions.md（外部调研决策格式与"6 概念冻结"决策 2）
  - docs/proposals/011-execution-plan.md（open infrastructure 执行状态）
  - docs/proposals/012-flow-first-class-alignment.md（§3.5 锚点粒度限制、§4.4 多语言 T4 推迟——本文多处引用）
---

# NanoNets/Graft 调研与吸收实施计划

Graft 是 NanoNets 开源的"AI coding agent 上下文层"：tree-sitter 建每符号 wiring 图（零 LLM 层）+ 两趟 LLM 生成 markdown 概念节点，配深度 Claude Code 集成（hooks / statusline / 上下文注入）与多 agent init。本文档记录对其源码的精读结论、与 codeontic 的定位对比、逐项吸收/不吸收决策及实施计划。格式沿用 proposal 004 的决策记录惯例，防止后续被重新解释成"没评估过 Graft"或"应该照搬 Graft"。

## 0. 一句话结论

Graft 与 codeontic 方向相反——Graft 从代码派生描述（回答"代码是什么"，图是 git-ignore 的可再生缓存），codeontic 维护独立规范模型（回答"代码是否符合应然"，模型入库为事实源）；**内核不借鉴，工程外围大量借鉴**：吸收 5 个技术点（owned-section 幂等 init、crux 文本锚、Claude Code hooks 推送、多 agent host registry、模型检索入口），明确不吸收 5 项（LLM 生成层、wiring 代码图、tree-sitter 多语言即刻跟进、monorepo scope 联邦、tokens-saved 计量），各附 re-trigger。

## 1. 定位对比：为什么不是竞品

| | Graft | codeontic |
|---|---|---|
| 事实源 | 代码；图是派生缓存，`ensureGitignored` 每次 build 自动把 `graft/` 写进 `.gitignore` | 模型；YAML 入库、与代码同 PR 原子提交（001 §2） |
| 方向 | 代码 → 图（描述） | 模型 → 代码（conformance）+ 代码 → 模型（reconcile），方向永不反转 |
| `check` 失败的含义 | "图落后于代码，重跑 build 即可"（缓存失效） | "代码违背模型"（债务，需人做决定：改代码或改模型） |
| LLM | 两趟生成 pass（per-file summary + 概念归组），content-hash 缓存 | 零 LLM 红线（001 §0.7），建模由目标仓库的 agent 起草、人确认 |
| 解析 | tree-sitter（TS/TSX/Python/Go），每符号 wiring 图 | 无代码图；adapter 提供 fact 提取（`git grep` 预筛 + 纯函数提取器） |
| Agent 集成 | 深：settings.json hooks ×5、statusline、SessionStart 注入、8+ agent host registry、MCP | SKILL.md（仅 Claude Code）+ 6 个 MCP 查询工具 + "给目标仓库 agent 的 prompt" |

结论与 004 决策 1 同构：**不换内核、不改定位**。Graft 恰是 README"Why it's different from a code graph"一节所指的 from-the-code graph——它结构上无法发现"代码错了"。两者甚至可在同一仓库共存（Graft 管省 token 的代码描述，codeontic 管行为规范对账）。可吸收的是它明显更成熟的**工程外围**：init 幂等机制、hooks 推送侧、多 agent 覆盖。

## 2. 决策 A：不吸收的（逐项理由 + re-trigger）

### A1 不引入 LLM 生成层（summary/crux 自动生成、概念归组）

001 §0.7 红线：CI 与引擎默认零 LLM、确定性。Graft 的 summary/crux 由 LLM 选定（`src/ai/crux.ts` 每文件一次 forced tool-call）；codeontic 的对应物是**建模 agent 起草 + 人确认**（agent-kit 的 loop-discovery 流程），生成智能留在目标仓库的 agent 侧，引擎只做确定性校验。**Re-trigger：无**——这是定位，不是权衡。

### A2 不建代码 wiring 图，不把模型变成派生缓存

Graft 的 `wiring.json`（每符号节点 + calls/imports/extends 边）是其描述性定位的内核。codeontic 刻意不维护全量代码图：reconcile 只提取 adapter 声明的"registerable 信号"，模型节点是人筛选过的行为抽象（backtest 判据 C 就在防"模型退化成目录清单"）。建 wiring 图会诱导模型向代码图滑坡。**Re-trigger**：若未来某个确定性检查（如 delegation 追踪）实证需要跨文件调用边，届时按需建**局部**调用解析，不建全量图；Graft `src/graph/resolve.ts` 的置信度分级（`extracted`/`inferred`、歧义即丢弃不猜）和 `BUILTIN_CONTAINER_TYPES` 防误连清单是现成参考。

### A3 tree-sitter 多语言不即刻跟进——归档为 012 T4 的输入

012 §4.4 已决策：多语言（T4）推迟，等 ⑤ 全矩阵实测结果驱动。本调研为 T4 补充两条输入，记录在此防丢失：

1. **可行性证据**：Graft 用 tree-sitter-typescript/python/go 三个 grammar 覆盖四语言，符号种类收敛到 8 种（file/class/function/method/interface/type/enum/struct），证明该路线对"提取符号 + 判定符号存在"这一粒度是低成本可行的——正好是 codeontic `validate/symbol.ts` 文本匹配之外的候选升级路径（但注意 symbol.ts 头注释记录过 AST 声明查找产生 14 个全误报的教训，升级需保留"提及即通过"的宽松语义）。
2. **实现 gotcha**：tree-sitter 字符串 `parse()` 对 ≥32KB 输入静默失败，必须用 callback 分块形态（Graft `PARSE_CHUNK = 16384`，`src/graph/extract.ts`）。T4 落地时直接采用。

### A4 monorepo scope 联邦暂不做

Graft 的 per-scope 排名 + RRF 融合（`src/ask/fuse.ts`，rank 位次跨语料可比而原始分不可比）解决的是"大子项目按分数淹没小子项目"的**语料级检索**问题。codeontic 的查询对象是几百节点量级的模型而非几万节点的代码语料，不存在该问题；conformance 已有 `byComponent` 分组。**Re-trigger**：B5（模型检索入口）落地后，若某个真实 目标仓A 的模型规模或多仓形态使单一排名失真，再引 RRF——届时 `RRF_K=60`、participation gate 用绝对阈值不用比例阈值（Graft 注释记录了比例阈值随语料增长漏垃圾的实证）这两条直接抄。

### A5 tokens-saved 计量暂不做

Graft 的 `[graft] tokens saved ≈ N` footer 与 hooks 累计（`tool-savings` 正则回收）服务于其"省 token"的核心卖点。codeontic 的价值主张是正确性（防漂移）不是省 token，已有 backtest 三判据做效果度量。**Re-trigger**：若未来要写对外的效果叙事（README benchmark 一类），Graft 的口径可参考——baseline = 命中文件整读 token 数、chars/4 估算、**baseline ≤ pack 时整段省略绝不虚报**（`src/context/savings.ts`），这个"不虚报"纪律无论何时都适用。

## 3. 决策 B：吸收的技术点总表

| # | 技术点 | Graft 来源（文件） | codeontic 落点 | 阶段 | 状态 |
|---|---|---|---|---|---|
| B1 | owned-section 幂等 init（marker 区块内更新、区块外保留、写前等值短路、plan/dry-run 单一事实源） | `src/hosts/sections.ts`、`src/context/node-file.ts`、`src/hosts/plan.ts` | `src/cli/commands/init.ts`、`src/cli/assets/agent-kit.ts` | P1 | 待实施 |
| B2 | crux 文本锚（文本为真、行号仅写时消费一次；填 012 §3.5 已登记的"符号级粒度不够"缺口） | `src/graph/enrich.ts#buildCrux`、`src/graph/types.ts#Crux` | `src/schema/model.ts`、`src/validate/`（新 check）| P1 | 待实施 |
| B3 | Claude Code hooks 推送侧（post-edit 模型 blast radius、SessionStart 模型概览注入、settings.json 幂等合并、fail-soft） | `src/claude/hooks.ts`、`settings-merge.ts`、`format.ts` | 新 `src/cli/commands/hook.ts` + init 扩展 | P2 | 待实施 |
| B4 | 多 agent host registry（探测 + section/owned 两型写入 + MCP 注册合并） | `src/hosts/registry.ts`、`mcp-config.ts`、`instructions.ts` | 新 `src/hosts/`（复用 B1 的 upsert） | P2 | 待实施 |
| B5 | 模型检索入口 `model_search`（任务文本 → 相关节点，确定性排名） | `src/ask/ask.ts` 的信号设计（name×3/path×2/body、test 降权、escalation nudge） | `src/query/` 新查询 + MCP 新工具 | P3 | 待实施 |

横切工程模式（并入各点实施，不单列任务）：**确定性序列化**（排序、无时间戳，重跑字节一致——codeontic views/side-channel 大体已符合，B1/B3/B4 的新写入必须遵守）；**写前内容等值短路**（重跑零文件系统扰动、零 git diff）；**hooks 全方向 fail-soft**（任何子进程/读文件/import 都包裹，宁可静默降级绝不搞挂 session）；**原子写**（临时文件 + rename——`side-channel.ts` 已有，复用）。

与既有决策的关系声明：B2 加的是**字段不是 kind**，不触碰 004 决策 2 的"6 概念冻结"；B1–B5 均不改 `ADAPTER_INTERFACE_VERSION`（全在引擎/CLI 侧，adapter 边界零变化）；B3 部分修订 init.ts:84 "只发 prompt 不发成品"的立场——该立场的论据是"各仓库 CI 惯例不同"，对 CI workflow 成立，对结构固定的 hosts 配置文件（settings.json/rules 文件格式由各 agent 厂商定义，不因仓库而异）不成立，故 hooks/host 配置改为成品直写，CI workflow 维持 prompt 形态不变。

## 4. 各技术点最小设计草案

### B1 owned-section 幂等 init（P1）

**问题**：init 全部文件 skip-if-exists（init.ts），codeontic 升级后用户拿不到新 kit 内容；唯一的版本机制 `codeontic-pin:` 只能警告"pin 落后了，请手改"。

**设计**（语义对齐 Graft `upsertSection`，逐条采纳其实证细节）：

- 标记：`<!-- codeontic:managed:start -->` / `<!-- codeontic:managed:end -->`，要求**独占一行**（`trim() === marker` 判定，防止行内偶现误配）。
- `upsertManagedSection(path, body)` 返回 `created | appended | replaced | unchanged`：两标记都在 → 区块内替换、区块外原样保留；内容等值 → `unchanged` **不落盘**；无标记的既有文件 → 追加区块（首次迁移路径）；文件不存在 → 创建。
- EOL 处理：探测主导行尾（存在任一 `\r\n` 即 CRLF），按 `/\r\n|\n/` 切行比较，写回用探测到的 EOL；body 先剥 `\r` 防 CRLF 文件双重回车。（Graft `sections.ts` 的实证细节，直接采纳。）
- 标记被手删 → 视为无标记文件重新追加区块（fail-safe 不 fail-preserve，与 Graft `preserveHuman` 同向）。
- 适用文件的逐个决策：
  - `agent/loop-discovery.md`、`setup-pr-template.md`、`setup-github-actions.md`、`.claude/skills/codeontic/SKILL.md` → **转 managed**：生成内容入区块，用户补充写区块外。`setup-github-actions.md` 的 `codeontic-pin:` 标记移入区块内，升级时随区块更新——`staleVersionPins` 警告机制保留用于**无标记的旧版存量文件**（不回溯改造，见下）。
  - `config.json`、`model/README.md`、`adapter/README.md` → **维持 skip-if-exists**：config 创建后归用户所有；两个 README 是一次性引导。
- 存量兼容：已存在但无标记的文件**不自动改写**，init 打印一条迁移提示（"delete the file and re-run init, or add markers manually"）——旧文件可能被深度定制，静默重构是破坏。
- plan/dry-run：抽 `initTargets(targetDir): PlannedWrite[]`（Graft `plan.ts` 模式），dry-run、实际执行、测试断言消费同一列表，三者不可能不一致。

**测试要求**：区块替换/追加/创建/等值不写各一例；CRLF 文件往返不双重 `\r`；标记手删后的重建；区块外用户内容含伪标记字样（非独占行）不被误配;双跑 init 第二次全 `unchanged` 且目录 mtime 外零变化。

### B2 crux 文本锚（P1）

**问题**：锚点只有 `path#symbol` 两级；checks.ts:391 明确记录盲区——god-file 拆分后留下委托空壳，文件在、符号在、行为已搬走；012 §3.5 登记"同一函数内两条路径无法表达"为下一轮 schema 输入。crux 正面回应这两条。

**设计**（核心采纳 Graft 的"文本为真、span 仅指示"原则——`Crux.code` is the source of truth; `span` is never used to re-slice）：

- Schema（`model.ts`）：Loop 与 Flow 增加可选字段
  ```yaml
  crux:
    - anchor: "packages/orders/src/order-service.ts#OrderService"  # 必须 ∈ 本节点 anchors
      text: |
        if (order.status === "cancelled") return;   # 承载行为的原文片段
      note: "cancelled 终态守卫"                     # 可选，≤200 字符，沿用 EVIDENCE_NOTE_MAX
  ```
  约束（schema 强制）：`text` 非空、≤12 行（对齐 Graft `MAX_CRUX_LINES`）、≤1200 字符；`anchor` 引用完整性并入现有 `checkReferentialIntegrity` 同类处理（必须是本节点 `anchors` 之一——crux 是对既有锚的细化，不是第三种锚点形态）。
- 校验（新 check `anchor-crux`，落在 `src/validate/` 与 anchor 检查同层）：读锚点文件（沿用 `MAX_SYMBOL_SCAN_BYTES` 上限与 `SOURCE_EXTENSIONS` 范围），两级匹配——先原文精确子串；不中则**空白归一**（各行 trim、行内空白折叠、按行序拼接）后再匹配，抵抗纯格式化 churn。仍不中 → `warning`，措辞指向决策而非机械修复："crux text no longer found in <file> — behavior may have moved; update the model or restore the code"。
- 严格性：与 `anchor-symbol` 同姿态——**始终 warning，`--strict-anchors` 不提升**。理由同 symbol.ts 头注释的误报教训：文本匹配的假阴性（合法重构改了措辞）成本必须低。
- v1 范围收口：只做 Loop/Flow 的 `crux` 字段 + check 集成。**不做** conformance 新 gap kind、**不做** Junction `evidence[].snippet`、**不做** `check --diff` 的 crux 级增量——全部留给使用反馈驱动（见 §6）。
- 与 012 ⑤ 的关系：字段可选、纯增量，⑤ 的实测仓库无需回填 crux；但 ⑤ 中发现的"符号级不够"实例应优先用 crux 表达，作为该字段的第一批真实消费者——**沿用 A2/state_carrier 的纪律：有真实消费者才扩展形状**。

**测试要求**：精确命中/空白归一命中/未命中警告三态；≥12 行与空 text 的 schema 拒绝；`anchor` 不在节点 `anchors` 内的引用错误；超大文件跳过不误报;`--strict-anchors` 下仍为 warning。

### B3 Claude Code hooks 推送侧（P2，依赖 B1 的合并机制风格）

**问题**：现有集成全是"拉"（agent 主动查 MCP/CLI）；agent 改到被模型锚定的文件时无任何即时信号，问题要等 PR 门禁才暴露。codeontic 的检查亚秒级零 LLM，做"推"的边际成本几乎为零——这是 Graft 花大力气做 hooks 而 codeontic 免费得到的能力。

**设计**：

- 新命令 `codeontic hook <event>`（`post-edit` | `session-start`），从 stdin 读 Claude Code hook JSON，输出 `hookSpecificOutput.additionalContext`。**不引入 Graft 的 shim `.cjs` 间接层**——Graft 需要 shim 是因为它常装在全局、逻辑要随包升级；codeontic 以 devDependency 进目标仓库（001 §2 既定），hook 命令直接走本地 `node_modules`，一层间接是不需要的复杂度。
  - `post-edit`（matcher `Write|Edit|MultiEdit`，timeout 10s）：对被编辑文件跑现有 `affectedNodes(graph, [file])`（diff.ts 的文件级映射，零新算法），命中则注入：
    ```
    [codeontic] 该文件被模型锚定：L1 (loop) — boundary: pending → processing → …
    提交前请跑 codeontic check . --diff <base> 验证。
    ```
    未命中 → 静默零输出。编辑 `.codeontic/` 自身 → 跳过（防自触发循环，同 Graft `underGraft` 守卫）。
  - `session-start`（timeout 8s）：注入现有 `runSummary`（`src/query/summary.ts`）的模型概览 + MCP 工具清单与调用纪律。SessionStart 输出进缓存只付一次成本，可以详细——Graft 在代码注释里点明的这个 token 经济学判断直接采纳。
- **fail-soft 是硬约束**：模型加载失败、YAML 解析错、git 不可用——一律 stderr 记一行、`additionalContext` 空、exit 0。hook 永不搞挂用户 session。
- init 侧：`codeontic init --hooks claude` **显式 opt-in**（v1 不默认——改用户 `settings.json` 是侵入性动作，与 Graft 的默认全装姿态刻意不同；默认化留 re-trigger：真实用户反馈要求）。写入 `.claude/settings.json` 采用 Graft `settings-merge.ts` 的幂等技巧：**按指纹字符串（`codeontic hook`）删除旧条目再追加现行条目**——天然幂等且可升级，不做原位 merge;JSON 不可解析 → `skipped-unparseable` 绝不重写；已有他人 hooks 原样保留。
- statusline 归入 P3 开放问题（需要 stats 缓存文件才能纯读渲染,v1 不建）。

**测试要求**：stdin 畸形 JSON / 模型缺失 / 非 git 环境三类 fail-soft（exit 0 + 空输出）；`affectedNodes` 命中与未命中；settings.json 合并双跑等幂（第二次零 diff）、含既有第三方 hooks 的保留、不可解析 JSON 的拒写。

### B4 多 agent host registry（P2，依赖 B1 的 `upsertManagedSection`）

**问题**：多 agent 支持目前只有 SKILL.md 末尾一句"Cursor / Codex / Gemini CLI 也可读本文件"的被动声明；MCP server 存在但没有任何 agent 的注册配置生成。

**设计**（Graft `registry.ts` 的表驱动结构直接采纳，条目收敛）：

- `src/hosts/registry.ts`：`HostTarget { id, relPath, kind: 'section' | 'owned', detect(probe), content() }`，v1 条目：

  | id | 文件 | kind | 探测 |
  |---|---|---|---|
  | `agents` | `AGENTS.md` | section | `~/.codex` 或 `~/.config/opencode` 等 |
  | `cursor` | `.cursor/rules/codeontic.mdc` | owned | `~/.cursor` 或 `<repo>/.cursor` |
  | `gemini` | `GEMINI.md` | section | `~/.gemini` |
  | `copilot` | `.github/copilot-instructions.md` | section | `<repo>/.github` |

- 指令正文单一来源：从 SKILL.md 的核心段提炼 `instructionBody()`，各 host 只加薄封装（cursor 加 `alwaysApply: true` frontmatter 等）——canonical body + thin wrapper，杜绝多份漂移。
- MCP 注册：`mergeJsonKey` 模式写 `.mcp.json`（Claude）、`.cursor/mcp.json`、`.gemini/settings.json` 的 `mcpServers.codeontic = { command: "npx", args: ["-y", "codeontic@<pin>", "mcp"] }`——pin 沿用 `versionToPinSpec` 既有策略，杜绝 `@latest`（setup-github-actions 的既定纪律）。等值短路、不可解析拒写,同 B3。
- section 型写入复用 B1 的 `upsertManagedSection`;owned 型写前内容比较。
- init 交互：v1 不做 Graft 的 TTY picker，`codeontic init --agents cursor,gemini` 显式列举 + `--agents auto` 按探测写入;非 TTY 无参数时只打印探测结果不写（Graft 0.8 的非交互零写入姿态，采纳）。

**测试要求**：各 host 文件的创建/更新/等值不写;section 型对既有用户内容的保留;探测函数对 home/repo 两级目录的判定;MCP JSON 合并的幂等与既有条目保留。

### B5 模型检索入口 `model_search`（P3）

**问题**：6 个 MCP 工具全部要求先知道节点 id;agent 拿到一个任务描述时无从下手,只能整读 overview——正是 001 §1 "prose 不可切片查询"批评的残留形态。

**设计**（吸收 Graft ask 的信号设计,规模上大幅简化——几百节点的模型不需要 sidecar 索引和 BM25 全套）：

- `runSearch(targetDir, query)`：分词（camelCase 拆分 + 小写 + 去单字符,采纳 Graft tokenizer 语义）后对每节点打分：`title/id ×3 + owner/anchors 路径 ×2 + boundary/summary/notes ×1`,idf 加权;查询词二值化（防长 query 单词重复放大,Graft 的实证细节）。命中节点做 1-hop 扩展（复用 `impactOf` 的反向边收集）标注 `related`。
- 输出走既有 side-channel 形态：stdout 紧凑 top-N + `.codeontic/ws/search-<hash>.md` 全量。
- MCP 工具 `model_search` 注册,description 采纳 Graft 的 **escalation nudge** 反模式提示：命中 ≤3 时明确引导"不要换措辞重问,改用 model_inspect/overview"——防 over-ask 陷阱。
- 明确不做：PageRank/RRF（A4 的 re-trigger 管辖）、持久化索引（模型量级不需要）。

**测试要求**：中英混排 title 的分词命中;id 精确命中排最前;零命中时的引导文案;确定性（同输入同输出、结果排序稳定）。

## 5. 实施顺序与依赖

```
P1（可即刻并行于 012 ⑤,互不阻塞）: B1 ──┐
                                    B2 ──┤ 两者相互独立
P2（依赖 B1 的 upsert 机制）:            ├→ B3 → B4（B4 复用 B3 的 JSON 合并与 B1 的 section upsert）
P3（独立,随时可做,优先级最低）:          └→ B5
```

- **不打断主线**：012 ⑤（全矩阵实测 + before/after 报告）仍是当前主线;B1/B2 是小而自足的增量,适合作为 ⑤ 间隙的并行任务。B2 与 ⑤ 有正向耦合——⑤ 实测中发现的符号级粒度不足实例是 crux 字段的第一批真实消费者。
- **每点一 PR**,各自带上文列明的测试;B3/B4 涉及写用户配置文件,PR 描述须附双跑幂等的测试证据。
- 版本策略：B1/B2 落在一个 minor（schema 增字段 + init 行为变化都是向后兼容的增量）;B3/B4/B5 各随后续 minor。

## 6. 不在本次范围内的开放问题

- **statusline**：Graft 的方案依赖 hooks 维护的 `stats.json` 缓存（statusline 纯读不起子进程）。codeontic 若做,需先有 B3 的 post-edit hook 写缓存;显示内容候选是 conformance 计数（`8 met / 3 partial / 1 gap`）与模型 staleness。留待 B3 落地后按真实需求决定。
- **conformance 消费 crux**：crux 未命中是否升格为新 gap kind（如 `crux-missing`）,取决于 B2 的 warning 在真实使用中的信噪比——误报率低再升格,先 warning 观察。
- **Junction evidence 的 snippet 扩展**：同一机制对 `evidence[].anchor` 理论上同样适用,等 Loop/Flow 的 crux 有真实使用量再扩。
- **hooks 默认开启**：v1 显式 opt-in;若 ⑤ 之后的真实用户一致要求,再改默认并补 `--no-hooks` 逃生门。
- **`check --diff` 的符号/crux 级增量**：目前文件级映射（改一个文件点亮全部锚定节点）。crux 字段落地后,理论上可用"变更行是否触及 crux 文本"做更细的受影响判定——但这需要 diff hunk 解析,成本不小,等文件级噪音被实证抱怨后再做。
