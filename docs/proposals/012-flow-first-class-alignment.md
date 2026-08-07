# Proposal 012 — Flow 一等公民之后：定位、叙事与实现的一次对齐

> 状态：**两个决策已拍板**（§1 = B，§2.2 = 选项 1），T1/T3 已落地
> 追踪 issue：[#21](https://github.com/krislavten/codeontic/issues/21)
> 相关 PR：[#12](https://github.com/krislavten/codeontic/pull/12)（F1/F2a/F2b + 消费者修复）

## 0. 触发与问题陈述

PR #12 给 `Flow` 加了 `anchors` / `scenarios`，让零-loop 仓库（reskill）的履约成绩单从
`0 graded` 点亮成 `1 met / 1 partial`。评级逻辑本身扎实，但改动在**没有做出定位决策的前提下
先做了实现**，由此暴露三层未对齐：

| 层 | 症状 |
|---|---|
| 代码 | 新绑定通道只接进 7 个消费者里的 2 个 → 6 个用户可见问题（已修，见 §4.1） |
| 叙事 | `agent-kit.ts` 的发现指令只字未提 flow 可挂锚点 → **新能力在自家 LLM 发现管线里不可发现** |
| 定位 | `Flow` 同时承载「组合视图」与「持有实现的执行单元」两种语义，无字段声明，引擎运行时推断 |

PR #12 里的「三态门」不是复杂度的源头，是这个 overload 的**症状**。

---

## 1. 定位决策（决策门）

> codeontic 是「控制循环专用建模工具」，还是「通用的行为 traceability 工具」？

| | A：控制循环专用 | B：通用行为 traceability |
|---|---|---|
| 卖点 | 循环最易失控、最难看清，值得专门建模 | 任何行为声明都要有代码锚点和测试守护 |
| 核心资产 | Loop / Junction | Anchor + Scenario 的对账闭环 |
| CLI 仓库 | 不在射程内 | 一等公民 |
| 适用面 | 窄 | 宽 |
| 差异化 | 强 | 弱（要与通用 traceability / ADR 工具竞争） |

**建议选 B，保留 A 作为最高价值场景。** 真正可复用的资产是对账闭环
（model 声明 → anchor 钉代码 → scenario 钉测试 → 确定性检查 → 缺口清单），不是 loop 这个形状；
这套闭环对线性 CLI 同样成立。Loop / Junction 不降级，它们仍是收益最高的建模对象。

**命名不改。** `codeontic` 的 loop 可重新解释为那个对账闭环（model → code → check → model），
而不只是被建模对象里的控制循环——比原义更 general，且零代码成本。npm 包名与 `/codeontic`
skill 前门的迁移成本远超收益。

---

## 2. 叙事 / 本体论变更

### 2.1 被建模的行为单元

现有本体论的隐含前提是「行为单元 = 会自己推进的机制」（Loop 的 "independent advance
mechanism" 判据、DebtEntry 对不通过者的排除，都是它的产物）。选 B 之后改为：

> 被建模的行为单元 = 一段值得被钉住的行为，无论它自主推进（loop）还是被触发一次就结束（path）。

**Loop 的判据必须保持严格**——放宽它会让 debt 的判据一起垮掉。这是在它旁边新增一类，不是稀释它。

### 2.2 Flow 双语义显式化 ✅ 已拍板：**选项 1**

**选项 1（推荐）**：`Flow` 加 `shape: "composed" | "anchored"`，配三条硬规则，
**不留任何「合法但静默无效」的中间地带**：

1. `composed` 声明 `anchors` → schema 层报错（不是忽略）。
2. `anchored` **允许**同时组合。reskill 的 C2（自己锚定 update 专属代码 + `references` C1）
   是真实且有测试覆盖的用例，锚点是它自己的贡献，不与被组合部分重复计分。PR #12 这一点判断正确。
3. **任何 shape 的 own `scenarios` 永不静默丢弃**——要么参与评级，要么显式报错/warn。

> `anchored` + 组合不是「第三种状态」：`shape` 已声明该节点持有自己的实现，组合只是附加结构信息。
> 写清楚是因为它影响未来若升级到选项 2 时的迁移路径，该路径本提案不预先锁定。

**选项 2**：新增 kind `path`，`Flow` 回归纯组合视图。本体论更自洽，且下游 `switch (node.kind)`
天然穷尽（TS 强制每个消费者处理新 kind——正是它能从类型层面防止本次的 bug 复发）。
代价是破坏性 schema 变更。

**决策：选项 1。** 不选选项 2 的理由——选项 2 唯一的实质优势是「TS 编译器强制每个消费者
处理新 kind」，而 T3 的扇出契约测试已经堵上了这个洞（它当场就抓到了 junction verdict 那个
既有 bug）。**用测试换掉破坏性变更，划算。** 且选项 1 可升级：将来真要拆类型，
`shape: anchored` 的 flow 机械转成 `path` 即可，不白做。

### 2.3 id 空间

`FlowId = /^C\d$/` 只有 C1..C9。既然选 B，CLI 命令级数量级可预期，放宽为 `/^C\d+$/`，
列为 T1 前置任务，不再作为待议项。

### 2.4 发现管线必须同步（T1 的 DoD，不是并行任务）

- `src/cli/assets/agent-kit.ts`：补 anchored flow 的建模指引与判据
- `docs/prompts/loop-discovery.md`：同上
- `/codeontic` SKILL.md：零-loop 仓库的路由路径
- README schema 示例：补一个 anchored flow

**硬验收：在零-loop 仓库上跑自动发现，草案里应出现 anchored flow。** §3 的实测证明这条不是形式主义。

---

## 3. 实测证据：claude-code 发现基线

用 [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code)（Claude Code
可运行重建版，TypeScript，3249 个 `.ts/.tsx`）做**改造前基线**，严格执行现有
`loop-discovery.md` 四遍扫描法。

### 3.1 发现结果

6 个 loop，全部通过三判据，**锚点全部经 `--strict-anchors` 对 HEAD 核实通过**：

| id | loop | 锚点 |
|---|---|---|
| L1 | agentic 主循环 | `src/query.ts#queryLoop`（`while(true)` at :460） |
| L2 | 会话生命周期与上下文压缩 | `src/QueryEngine.ts#QueryEngine` |
| L3 | 流式响应消费 | `src/services/api/claude.ts#queryModelWithStreaming` |
| L4 | 后台清理 | `src/utils/backgroundHousekeeping.ts#startBackgroundHousekeeping` |
| L5 | cron 调度 | `src/utils/cronScheduler.ts#createCronScheduler` |
| L6 | REPL 交互循环 | `src/screens/REPL.tsx#REPL` |

```
conformance: 0 met / 6 partial / 0 gap (of 6 graded), 1 composition-only flow(s) excluded
```

### 3.2 基线暴露的缺口

**发现管线找到了全部 6 个 loop，但一条 flow 的代码都没绑上。**

`loop-discovery.md` Pass 3 对 flow 的唯一定义是「端到端有序穿越（一次用户可见的完整旅程
**跨多个 loop**）→ flow」，通篇未提 flow 可挂 anchors。后果：

1. **C1（一次完整会话）建成纯组合型**，`traverses: [L6, L1, L3, L2]`，零锚点 → 被排除出评级。
2. **CLI 启动链完全没进模型。** `cli.tsx#main → main.tsx#main → getToolsForDefaultPreset →
   REPL` 是文档站列为首位的主用户旅程，但它不是「跨多个 loop 的组合」，而是一次性引导路径；
   按 Pass 2 归宿表第 7 行「boot 一次性任务 → 不建模(bootstrap)」被**显式判定为不建模**。
3. **Pipe mode（`echo ... | claude -p`，`src/main.tsx:770`）同样落空**——典型的零-loop
   一次性管线，正是 F1 想服务的形态，而发现指令没有任何位置容纳它。

即：**schema 层的能力（PR #12 已提供）与发现层的指令（未更新）脱节**，能力存在但产不出。
这为 §2.4「发现管线同步是 T1 的 DoD 而非可后补的文档尾巴」提供了直接证据。

### 3.3 与文档站架构描述的比对

对照 [what-is-claude-code](https://ccb.agent-aura.top/docs/introduction/what-is-claude-code)：

| 文档站声称 | 基线发现 | 判定 |
|---|---|---|
| Agentic Loop（`query.ts`） | L1 | ✅ 命中 |
| Session/compaction（`QueryEngine.ts`） | L2 | ✅ 命中 |
| Streaming（`claude.ts`） | L3 | ✅ 命中 |
| Tool Execution Layer | — | ⚠️ 未建为独立 loop：被动调用，三判据「独立推进机制」不通过 |
| Standard CLI Flow | — | ❌ **漏**（§3.2 第 2 点） |
| Pipe Mode | — | ❌ **漏**（§3.2 第 3 点） |
| — | L4 / L5 | ➕ **额外发现**：文档站未提及的后台清理与 cron 调度 |

两点关于文档站本身的观察（非 codeontic 的问题）：
- 它给的是简称而非完整路径（`REPL.tsx` 实际在 `src/screens/`，`claude.ts` 在 `src/services/api/`），
  6 个组件全部真实存在。
- 它写的 `getTools()` 实际符号是 `getToolsForDefaultPreset`。

**额外发现（L4/L5）是正向信号**：发现管线找到了人写的架构文档漏掉的常驻机制，
这正是 codeontic 相对于手写文档的价值所在。**漏掉的两项全部是 flow 形态**，
且成因同一个——叙事层未对齐。

---

### 3.4 改造后对照(T1 落地后重跑)

用更新后的 `agent-kit` 指令(Pass 1 拆 A/B 两类候选、Pass 2 归宿表补「一次性执行路径 →
anchored flow」)对同一仓库重新执行发现:

| | graded | 覆盖 |
|---|---|---|
| before(旧指令) | 6 | 6 loop;CLI 启动链与 pipe mode **缺失** |
| **after**(新指令 + `shape`) | **8** | 6 loop + **2 条 `anchored` flow** |

```
before: 0 met / 6 partial / 0 gap (of 6 graded), 1 composition-only flow(s) excluded
after:  0 met / 8 partial / 0 gap (of 8 graded), 1 composition-only flow(s) excluded
```

新增两条,均 `--strict-anchors` 0 warning、锚点对 HEAD 核实通过:

| id | shape | 旅程 | 锚点 |
|---|---|---|---|
| C2 | `anchored` | CLI 启动引导链(argv 解析→运行时装配→交出控制权) | `src/entrypoints/cli.tsx#main`、`src/main.tsx#main` |
| C3 | `anchored` | 非交互模式(pipe / `--print` 一趟处理) | `src/main.tsx#initializeEntrypoint` |

**没有过度召回**:新判据把 `migrations/migrate*`(升级时跑一次,不是每次调用都重跑的主路径)
正确排除在 anchored flow 之外——归宿表新增行里那句「杀进 bootstrap 之前必问:这是启动时跑一次
就没人管的初始化,还是每次用户调用都会重跑的主路径?」起了作用。

这组对照是 §2.4「发现管线同步属于 T1 的 DoD」的闭环验证:**schema 能力(#12)+ 发现指令(T1)
两者齐备,新形态才真正产得出来**;缺任何一半,零-loop 与混合形态仓库的主路径都会继续缺失。

### 3.5 验收标准逐条(§6 的六条)

| 标准 | 结果 |
|---|---|
| 建模可完成性 | ✅ 无形态装不下。**被迫扭曲处 1 项**:C2/C3 同属 `main.tsx` 的不同分支,锚点粒度只能到符号级,无法表达「同一函数内的两条路径」——记为下一轮 schema 演进输入 |
| 成绩单非空且可信 | ✅ 8 graded,抽样核对 verdict 正确(全部 `partial`= 有锚点无 GWT,与该仓库无 codeontic 场景的事实一致) |
| 视图一致性 | ✅ `check`/`conformance`/`graph`/`overview`/`evidence`/`inspect` 对同一模型说法一致(T3 测试的自动化版本) |
| reconcile 假阳性率 | ⚠️ 未测:该仓库无 adapter,facts 提取跳过(见 §4.4) |
| 自动发现产出质量 | ✅ 6 loop 全部通过三判据且锚点核实通过;2 条 flow 由新指令产出 |
| 上手成本 | 从 `init` 到第一份可信成绩单约 30 分钟(3249 文件仓库,聚焦核心执行路径) |

## 4. 代码变更

### 4.1 已完成（PR #12，不依赖任何决策）

新绑定通道接进全部消费者，6 个问题均已实测复现并修复：

| 位置 | 原症状 |
|---|---|
| `validate/unregistered.ts` | reconcile 把 flow 锚定文件误报 unregistered（假阳性） |
| `query/queries.ts` | `evidence <flow>` / MCP `model_evidence` 报 `0 anchor(s)` |
| `query/slice.ts` | `inspect <flow>` 到不了守护它的 GWT |
| `views/graph-html.ts` | 已评级 flow 涂灰、gaps 丢失，summary 与 headline 打架 |
| `views/overview-html.ts` | 报告卡有数字没卡片；`flowsExcluded` 未显式露出 |
| 新 check `flow-scenario-ignored` | 组合型 flow 的 scenarios 被静默丢弃 |
| `views/overview-html.ts`(junction) | junction 参与评级、计入 headline,但页面上无处渲染其 verdict——报告卡能显示一个页面无法解释的 gap。**由 T3 测试当场抓到**,非本轮引入 |

附带把 `flowComposes` 提取到 `schema/model.ts` 作为唯一定义（原先只在 conformance 内私有，
新 check 会产生第二份拷贝——正是本提案批评的「判断散落」）。

### 4.2 T1 — 显式 shape + 判断集中化 ✅ 已完成(PR #24)

- `Flow.shape` 字段（依 §2.2 定稿）+ 三条硬规则
- 单一判据函数，所有消费者引用，禁止各自重写
- `FlowId` 放宽（前置）
- **agent-kit 同步更新（同一个 DoD）**

### 4.3 T3 — 防复发：扇出一致性测试 ✅ 已完成(PR #24)

本次 6 个 bug 同源：新增绑定通道时没有一份消费者清单。`checks.ts` 的 `collectReferences`
已有「reference 字段必须与 schema 同步」的告诫注释，anchor 侧也需要一份。

落地为 `test/anchor-fanout.test.ts`：`ANCHOR_SOURCES` 清单枚举每个能携带代码锚点的 schema
字段，逐一断言它到达每个消费者（`anchorFilesToResolve` / `coveredFiles` / `affectedNodes` /
`evidenceOf`），并断言所有视图与 conformance headline 不矛盾。下次加绑定字段时漏接会直接红。

**它当场抓到了 §4.1 表中最后一行那个既有 bug** —— 这就是它存在的理由。

### 4.4 T4 — 多语言可行性（推迟）

Proposal 010 之后本包不内置 adapter，非 JS/TS 仓库的 fact 提取会直接卡住。
建议先降级为「只验证文件级锚点 + conformance + 视图一致性」，把写 adapter 的必要性
交给实测结论回答。在「通用」定位被前两格实测验证之前，不投入。

---

## 5. 执行序

```
① PR #12 修 6 个 bug → 就绪待合并          ← 已完成，不依赖任何决策
① .5 claude-code 发现基线                  ← 已完成（§3），T1 改 agent-kit 前取得
② 拍 §1 定位 + §2.2 shape 选项 ✅ B / 选项1   ← 已决
③ T1（stacked 在 PR #12 之上）✅ PR #24
     shape + 判断集中化 + FlowId 放宽
     + agent-kit 同步（同一 DoD，※ 前置：schema 冻结点）
④ T3 扇出一致性测试
⑤ 全矩阵实测 + before/after 报告
     → T4 / 其余形状格 / 选项 2 迁移由 ⑤ 的结论决定
```

**T1 为什么 stacked 而非并入 PR #12**：§1/§2.2 是可能被否决的架构决策；分成两个 PR，
否决 T1 不会连带丢掉 6 个不依赖决策的 bug 修复。两者又都改同一批文件，不 stack 会硬冲突。

---

## 6. 实测矩阵（第一轮只做 2 格）

| 形状 | 验证什么 | 候选 |
|---|---|---|
| 重 loop | 原能力不回归 | claude-code（已做基线，6 loop）、BullMQ |
| 零 loop / 纯线性 CLI | 本次扩张的目标场景 | reskill（已接入）、changesets |
| 混合 | 两种 shape 共存是否打架 | 推迟 |
| 非 JS/TS | 「通用」叙事的硬支撑 | 推迟（见 §4.4） |
| 明确不适合 | 工具会不会诚实说「不适合」 | 推迟 |

验收标准（每仓库一份报告）：建模可完成性（**被迫扭曲建模处必须逐条记录原文**，
它是下一轮 schema 演进的输入）／成绩单非空且可信／六个出口互不矛盾／reconcile 假阳性率≈0／
自动发现产出质量／上手成本。

**第一轮砍到 2 格、推迟 T4，不是保守，是让主线能真的走完**——③④是一次小型重构，
⑤是给陌生仓库建模，对单人项目是数周量级。
