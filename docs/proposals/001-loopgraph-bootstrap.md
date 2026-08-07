---
title: "Proposal 001: codeontic 启动方案 —— 模型驱动工程控制系统"
date: 2026-07-17
status: Accepted (bootstrap baseline)
provenance:
  - 目标仓A PR 内部PR（模型驱动工程提案，调研，不合入）
  - 目标仓A 一个内部 PR（A系统 loop 与链路全景盘点，调研，不合入，作为种子场景集）
related:
  - docs/proposals/003-phase0-effectiveness-report.md（Phase 0 真实接入验证 + 有/无 spec 对照实验结论）
  - docs/proposals/004-external-survey-decisions.md（外部方案调研决策：改名、不换内核、不扩概念集、吸收的技术点）
---

# codeontic 启动方案

## 0. 一句话定位

codeontic 是一个**独立的模型驱动工程控制工具**（TypeScript CLI + MCP Server）：以结构化行为模型（Feature / Flow / Loop / Junction / Scenario(GWT) / Evidence）为规范事实源，把目标仓库的代码、测试、E2E 和可观测信号当作**投影与证据**，用确定性、增量、不调 LLM 的 CI 检查维持模型与实现的一致性，用少入口 MCP 查询 + file side-channel 给 Agent 提供任务相关的模型切片。

第一目标用户是 目标仓A（A系统）。通用化是 Phase 5 的可选收益，不是设计前提；任何通用抽象不得降低 A系统 的分析质量或 CI 速度。

## 1. 背景与问题归因

A系统 已进入"局部改码快，但跨 loop 衔接正确性依赖大量隐性上下文"的复杂度区间。调研（目标仓A 一个内部 PR）实测：平台由 ~62 个原子 loop（L1-L30 + N1-N32）组成，复合成 9 条端到端链路（C1-C9）；仅 C1"一次对话端到端"就横跨 ~10 个 loop、3 个进程；loop 之间存在 5 类衔接点风险（handoff / 幂等 / 状态投影 / 失败传播 / watchdog），是 bug 高发区；另有 6 类死状态机陷阱、同名异义状态字面量、三套 failure 词汇。

问题归因（两步，均有实证）：

1. **静态文档必然过期**，根因是"手工维护的快照没有一致性强制"，而非"写文档不够勤"。证据：目标仓A 的 `A系统-system-model.md` 需 7 个并行 subagent 定期重建，配套 drift 文档本身就是漂移的存在证明；两份 2026-05 设计稿因严重落后被删除。因此解是"文档必须成为模型的生成视图"。
2. **Agent 上下文过载**，根因是 prose spec 不可切片查询。关键链路横跨十余 loop，靠通读全部 spec + 代码重建全局心智的成本随复杂度超线性增长。

同时明确一个**结构性边界**：行为模型自己也是账本。工具能保证"模型-代码一致"（漂移检测、未注册拦截），不能保证"模型-意图一致"（模型描述的行为是否是用户想要的）。本方案的核心赌注是：**维护模型的主体是 Agent，人只做确认**——该赌注在 Phase 1 出口标准中量化验证，不作为隐含假设。

## 2. 形态：三分离

| 部分 | 放哪 | 内容 |
|---|---|---|
| **引擎** | codeontic 仓库 | model schema / loader / validator、linker、checker、query、视图生成、MCP server、CI runner——零 A系统 业务知识 |
| **适配器** | codeontic 仓库 `adapters/A系统/`（第一版内置，Phase 5 才抽接口） | 目标仓A 技术栈静态事实提取：Next.js route、pg-boss queue + QUEUE_SUFFIX 派生链、drizzle status/phase 列 + 写点定位、setInterval/cron/poller、vitest/E2E 标识、metric/event 名称 |
| **模型 + 债务基线** | **目标仓库**（目标仓A `model/**/*.yaml`） | 行为模型数据与代码同仓、同 PR、同 diff |

核心决策：**工具独立、模型数据不独立**。"先改模型再改代码"的工作流和"diff → 受影响节点"的增量 CI 都要求模型变更与代码变更原子提交在同一 PR。工具以 devDependency 进目标仓库，CI 跑 `codeontic check --diff origin/main`。

事实源分层（防双事实源混乱）：
- 行为模型 = **规范层**（"应该是什么"）。
- 目标仓库既有 `A系统-system-model.md` = **描述层**（"现在是什么"），过渡期继续有效，Phase 3 后其结构性内容由模型生成视图接管。
- 已合并 migration + `_journal.json` 等不可变历史 = **底层绝对事实**，模型只管行为语义层，不与之竞争。

## 3. 架构：单向管线，无常驻服务、无图数据库

```
target repo: model/*.yaml + code + tests + baseline
   │
 [extract]  适配器产出 ImplementationFact[]（anchor = 仓库根全路径#symbol，不用行号）
   │
 [link]     模型 Evidence 锚点 ↔ 事实解析；标注六态一致性状态
   │        conformant / unimplemented / unverified / drifted / unregistered / deprecated
 [check]    确定性检查 T0/T1（§6）→ exit code / PR 报告
   │
 ├─ [views]    mermaid 大图 / per-flow 图 / 测试矩阵（生成物，不手工维护）
 ├─ [query]    CLI+MCP：inspect / impact / plan / scenario / evidence
 │             响应 = 摘要 + workspace 文件路径（file side-channel）
 └─ [runtime]  Phase 4：可观测桥接（octo-cli），metric/event ↔ 模型节点，漂移/健康报告
```

YAML 加载为内存图（几百节点量级足够）。禁止引入图数据库 / RDF / OWL 作为任何阶段的前置条件。

## 4. 数据模型

六概念，schema 冻结于 Phase 0；ID 直接继承调研文档编号（C1-C9 = Flow，L/N 系 = Loop），junction 新增 `J-*`，场景 `GWT-<flow|loop>-<nnn>`，证据 `E-*`。

锚点规则：
- 一律用**仓库根全路径 + 符号**（`packages/control-plane/src/x.ts#SymbolName`），不用行号（行号漂移）。
- 同名路径消歧强制：禁止裸 `control-plane` 之类的歧义引用（目标仓A 同时存在 `packages/control-plane` 与 `apps/control-plane`），T0 对歧义引用告警。

```yaml
# model/flows/C1.yaml
id: C1
kind: flow
title: 一次对话端到端
traverses: [L1, L2, L15, L3, L4, L16]
guarded_by: [L9]                     # watchdog
crosses: [J-ready-dispatch, J-outbox-poller, J-backward-wire,
          J-failure-vocab, J-health-watchdog]     # 5 类衔接风险全覆盖
references: [C2, C3]                 # 子链占位，unimplemented

# model/junctions/J-outbox-poller.yaml
id: J-outbox-poller
kind: junction
risk_class: idempotency              # 5 类风险模式之一
between: [L2, L15]
scenarios: [GWT-C1-010, GWT-C1-011]
evidence:
  - id: E-C1-OUTBOX-001
    kind: test
    anchor: packages/control-plane/src/…/outbox.test.ts#双写事务原子性
  - id: E-C1-OUTBOX-002
    kind: durable_event
    source: apps/control-worker
    transport: durable_event         # direct / relay / durable_event
    anchor: packages/contracts#WorkerProtocolEnvelope + worker_protocol_jobs.payload
    binding: { image_revision: required }   # 防发版冻结镜像污染证据（C6 陷阱）
```

GWT 内置 5 类模板（handoff / idempotency / projection / failure-propagation / watchdog），junction 场景按模板实例化，不从零创作。GWT schema 强制短小（字段长度限制），长背景链接回 prose spec。

## 5. 事实缓存：机器级内容寻址，跨 worktree 共享

设计约束（来自真实工作流）：开发者大量使用 git worktree（单人可达数百个）；CI 是 fresh checkout。**缓存 key 与文件路径 / worktree 彻底解耦，只绑定"内容 + 提取器版本"。**

- 位置：`~/.cache/codeontic/`（XDG，`CODEONTIC_CACHE_DIR` 可覆盖），权限 `0700`；所有 worktree、所有 clone 共享。仓库内不放缓存。
- **L1 单文件事实**（纯函数于单文件内容）：key = `(adapter 版本, blob OID)`。OID 从 git index 取（`git ls-files -s`，微秒级、不读文件内容）。回退链明确为：① 文件在 index 且 working tree 未修改 → 用 index blob OID；② dirty / untracked / 无 index 条目 → 就地读文件算内容 hash（与 blob OID 同格式 `git hash-object` 算法，保证同内容跨路径命中同一条目）；③ 完全无 git 环境（如导出目录）→ 全量走内容 hash。注：shallow clone 的 index 对已检出树是完整的，blob OID 可用，不触发回退；回退路径②③均进 CI 测试覆盖。同一 blob 在所有 worktree 中 OID 相同 → 天然共享缓存，worktree 数量与缓存效率无关。
- **L2 跨文件派生事实**（QUEUE_SUFFIX 派生链、writer 全仓扫描、符号解析）：默认不落盘，从 L1 快速重算（L1 全命中时为内存级图运算）。带边界保护：依赖闭包节点数 / 耗时超阈值时降级为全量提取并明确提示，不无限重算。
- 并发安全：条目 immutable、write-once、tmp + atomic rename，无锁；容量上限 + LRU 清理；adapter 版本进 key，升级自然失效。
- 仓库内 `.codeontic/ws/` 仅保留 **query side-channel 输出**（agent 上下文本就是 worktree 作用域），即用即弃，gitignore，不承担缓存职能。

CI 原则：
- **正确性零缓存依赖**：缓存纯性能层，冷跑与温跑结果逐字节一致；fresh checkout 直接可跑。
- T0 冷跑 <5s；T1 冷跑成本 O(diff closure) 而非 O(repo)。
- 可选加速：nightly T2 全量扫描发 facts snapshot 为 CI artifact，PR job 恢复即温缓存。
- CI 对 git 的唯一要求：能解析 merge-base（fetch base ref 或足够 depth）；共享 runner 上强制 `CODEONTIC_CACHE_DIR` 指向 job 级临时目录。与 worktree 机制完全无关。

## 6. CI：成本分层 × 执法分档

| 层 | 内容 | 成本 | 入禁 | 状态 |
|---|---|---|---|---|
| **T0** | model schema 校验、ID 唯一、**跨节点引用完整性**（`checkReferentialIntegrity`）、**图无环**（`checkGraphAcyclic`，覆盖 `Loop.parent`/`Flow.references` 两条同 kind 边）、锚点格式与存在性、baseline 只减不增、**INV-1 canonical writer**（见下） | <5s | Phase 1 | 前 5 项已实现并合入（Phase 0 提前交付，见 [Report 003](./003-phase0-effectiveness-report.md) §1）；INV-1 尚未实现，仍是 Phase 1 目标 |
| **T1** | diff→受影响节点；新增 route/queue/poller 注册检查；QUEUE_SUFFIX 派生链跨包等价性（入队侧 enqueue 点 vs 消费侧 `apps/control-worker`，静态等价；payload/envelope 类型必须锚定 `packages/contracts` 导出符号）；**effective constraints 约束传播的语法/引用校验**（决策见 [Decision record 004](./004-external-survey-decisions.md) 技术点 2）；schema 变更的 migration 证据 | 秒~几十秒（增量+缓存） | Phase 3 | 未开始 |
| **T2** | 全量扫描、漂移报告、视图再生成、LLM 辅助建议 | 分钟级 | **永不进 PR 门禁**，周期跑 | 未开始 |

**INV-1 识别策略（执法依据 = 写表达式的代码位置，不依赖调用链归因）**：全仓扫描 `sessions` 状态列（status / gate / failure.is_primary）的**写表达式**（如 drizzle `update(sessions).set({…})`）所在文件位置，allowlist = `packages/control-plane`。**该 allowlist 及列清单属于目标仓库的 `codeontic.config.ts` 配置（由 `adapters/A系统` 消费），引擎核心不硬编码任何 A系统 路径**——引擎只提供"列写点扫描 + 位置 allowlist"这一通用检查原语。间接调用 / 分层封装不影响判定——写表达式总在某个文件里，那个文件必须在 allowlist 下。`packages/db` 的表无关泛型原语为注册例外；表名以变量传入的真动态写法判为 `unanalyzable write`，保守上报人审而非静默放过。事实条目记录 `write_site`（执法依据本身），不记录推导性的"经由路径"。

执法四档（与 T 层正交，按 Phase 递进）：报告 → 新增强制 → 关键 Flow 阻塞 → 全平台阻塞。债务基线：稳定 ID + owner + 移除条件，只减不增，禁匿名 glob 永久豁免。**CI 默认路径不调用 LLM。**

## 7. 工作流

**W1 初始化（一次性）**：`codeontic init`（config + `model/` 骨架）→ `codeontic import`（调研种子：62 loop ID + 9 Flow + 债务基线）→ `codeontic scan --full`。

**W2 日常开发闭环（主工作流）**：

```
需求 → MCP model_inspect（相关节点切片）
     → model_impact --files（影响面）
     → 先编辑 model/*.yaml（目标模型变更）
     → 本地 codeontic check
     → 实现代码 + 测试（测试绑定 GWT ID，如 it("[GWT-L6-003] …")）
     → pre-push（codeontic check --diff 与既有门禁并跑）
     → PR CI（T0/T1 + 漂移报告评论）
     → 人审同一 PR：模型 diff（行为语义）+ 代码 diff（实现）
```

模型、contracts schema、代码、测试是**同一个原子 PR**；"先改模型"是规划顺序，校验发生在 PR 快照级，无跨 PR 依赖死锁。

**W3 周期性（nightly）**：T2 全量扫描 → facts snapshot artifact → 漂移报告 → 视图再生成。

**W4 运行时（Phase 4）**：可观测证据桥 → Flow/Junction 健康与漂移报告。Sandbox 内证据按 transport 分级：agent-worker 直连 OTLP 不可达（不得作为 direct 证据）；经 gateway OTLP relay 的 span 注册为 `transport: relay` 并带环境部署前提；落库证据锚定 `packages/contracts` envelope schema + `worker_protocol_jobs.payload` / `session_events`。运行数据只证明实现状态，不反向自动修改模型。

## 8. 示例 Case：「空闲超时前 5 分钟推 idle_warning + 保活续期」

跨 loop 需求：L6 Idle Watcher（判定）→ session_events（跨进程载体）→ N30/N29（SSE 腿）→ 新 route（保活 API）→ 触碰 sessions 列（INV-1 红线）。

Agent 查询 `model_inspect "session 空闲超时 保活"` 秒回：

```json
{ "nodes": [
    {"id":"L6","kind":"loop","status":"conformant"},
    {"id":"L7","kind":"loop","status":"conformant"},
    {"id":"C4","kind":"flow","title":"会话复活","status":"unverified"},
    {"id":"J-idle-terminate","kind":"junction","risk_class":"handoff"}],
  "invariants": [
    "INV-1: sessions 状态列写点只允许 packages/control-plane",
    "INV-AXES: lifecycle_phase 与 status/usage_kind 三轴正交，勿混写"],
  "workspace": ".codeontic/ws/inspect-001.md" }
```

模型变更（先于代码）：新增 `GWT-L6-003`（warning 幂等推送，`verified_by: []` → unverified，不假装已覆盖）、`GWT-L6-004`（keepalive 经 packages/control-plane 续期）；L6 anchors 认领新 route；Evidence 锚定 `packages/contracts#SessionEventSchema.idle_warning`。

门禁拦截演示：忘登记 route → T1 `unregistered`；在 A系统 route 直写 sessions → **T0 INV-1 fail**（全局不变式，与模型锚点无关）；idle_warning 未进 contracts → 锚点存在性 fail。测试绑定 GWT ID 后节点翻 conformant；PR 上 CI 评论受影响节点 / GWT 状态 / 注册完整性。

Agent 获得的对比：

| 现状 | codeontic 后 |
|---|---|
| 通读 AGENTS.md + 千行 system-model + 相关 spec + grep，可能读到过期内容 | 2-3 个 MCP 调用拿任务切片（摘要 + side-channel 全量文件） |
| 不变式靠记忆/踩坑 | 查询即返回不变式警示 + CI 机器拦截 |
| 不知道改动波及哪些链路 | model_impact 给受影响 Flow/GWT/测试清单 |
| 测试覆盖靠感觉 | GWT→测试映射，缺口显示 unverified |

## 9. 调研种子导入计划（内部PR → 模型）

| 调研内容 | 进模型方式 |
|---|---|
| C1-C9 复合链路 | 9 个 Flow 节点，组成序列直接来自盘点表 |
| 62 原子 loop | 全部收编：L 系带五判据字段（边界/状态载体/归属/推进/恢复）深建模，按 Phase 推进；N 系 baseline-only（`unverified`），防"新增强制"档在 N 系文件上产生注册噪音；N30/N29 SSE 腿额外挂 `packages/contracts` 的 session_events schema 消费锚点 |
| 5 类衔接风险 | GWT 模板库（工具内置） |
| 6 死状态机 + 2 deferred + 同名异义字面量 + 三套 failure 词汇 + N8 休眠 | 债务基线初始条目（owner + 移除条件） |
| INV-1 / 三正交轴 / C6 Revision 冻结 | Invariant 场景；INV-1 进 T0；C6 作为 Evidence 有效性前置（runtime 证据绑 image/revision，防"E2E 跑在旧镜像却以为验证了新代码"） |

调研原文（目标仓A 一个内部 PR / 内部PR 全文）存入本仓库 `research/` 目录作为历史输入（后续 commit 引入）。

## 10. 落地路线

- **Phase 0（1-2 周）语义冻结 + 种子导入 —— ✅ 已完成**：schema 定稿、9 Flow 收编、loop 收编（62 是 内部PR 原文自己的约数"~62个"，机械精确统计后为 **66**——差值是 4 个内嵌子机 L1a/L1b/L3a/L20a，内部PR headline 数的计数口径不含它们，本项目的种子导入选择把它们各建成独立 Loop 节点，故实际数字比原文 headline 多 4，不是范围扩容，见 [Report 003](./003-phase0-effectiveness-report.md) §1）、债务基线生成、T0 checker 可跑（schema/ID 唯一/引用完整性/图无环/锚点格式与存在性，5 项，比原计划提前交付了引用完整性与图无环两项）。出口验证：8 loop 挂真实 目标仓A 锚点全部解析成功，真实使用中发现并修复 2 个真 bug。
- **Phase 1 C1 真实范围纵向样板**：10 loop（L1/L2/L15/L3/L4/L16/L9 深建模；C2/C3/SSE 腿 `unimplemented` 占位）+ 5 junction（含 J-failure-vocab、J-health-watchdog——失败传播与 watchdog 两类风险必须进样板）；30-50 条 GWT 绑定现有测试/E2E；T0 入禁；生成 C1 大图（渲染校验见 [Decision 004](./004-external-survey-decisions.md) 技术点 5）。
  - **出口标准已按 Phase 0 效果报告修正**：原"两个量化项"仍要，但**不再**把"比 prose 文档更好用"作为验收标准——[Report 003](./003-phase0-effectiveness-report.md) 的真实 A/B 实验显示这个标准现在不成立，目标仓A 现有的 `A系统-system-model.md` 在深度问答任务上不落下风。改用**更诚实的基准线**：C1 模型的深度（尤其 junction 的 evidence/scenarios，Phase 0 里还是空的 "unverified preview"）必须至少不输给 `A系统-system-model.md` 现有对 C1 的描述。
  - ① 一次模型更新由 agent 完成的耗时与人工确认成本（验证"agent 维护模型、人只确认"的核心赌注）；② codeontic check 与既有 pre-push 门禁联合执行耗时与冲突率。
  - **Phase 1 范围两处提前（[Proposal 006](./006-full-execution-plan.md) A1/A5，2026-07-20）**：(a) `Evidence.kind` 增补 `spec`/`issue` 两值（intent/planning 指针，与 runtime 证据分型），配 `note` 长度上限（锚点定位辅助信息，禁因果/背景叙述）——原属"随内容建模自然出现"，现明确为 Phase 1 A1 的 schema 前置；(b) `codeontic inspect` 最小子集从 Phase 2 查询命令族提前至 Phase 1 A5（含 staleness 过期主动警告消费端），因为 C1 样板的切片查询与深建模同相位交付更省返工。下方 Phase 2 条目的完整命令族仍在 Phase 2 补全。
- **Phase 1/2 补充技术点（[Decision 004](./004-external-survey-decisions.md) 决策 3）—— 2026-07-19**：effective constraints 约束传播（`applies_to` 选择器，query-time 计算不物化）**已完成**；junction/GWT 深建模节点起用 file-per-node 目录约定**已完成**；C1 大图生成加 Mermaid 渲染校验（`codeontic view <flow-id> --validate`，目前仅 C1 范围）**已完成**；side-channel 输出加 staleness 戳**核心机制已完成**（`codeontic view` 写出的文件自带 model-content-hash 戳），**但主动警告消费端未实现**——见 [Decision 004](./004-external-survey-decisions.md) 技术点 4 与文末开放问题。
- **Phase 2 适配器完整化**：全信号提取、增量 diff 影响分析、MCP + file side-channel 的完整查询命令族（`model inspect`/`model impact`/`model plan`/`model scenario`/`model evidence`，§4.2 设计的其余部分——`codeontic view` 只是其中最小可用的一个视图切片，不是补全）；staleness 戳的生成与比较原语已完成（见上），仍未做的是"读取历史 stamp、发现过期、主动警告或拒绝"这个消费端本身。
- **Phase 3 扩链路 + T1 入禁**：C2/C4/C6/C7/C8/C9；新结构注册强制 + 关键 Flow 阻塞档；T1 新增 effective constraints 语法/引用校验。
- **Phase 4 运行时闭环**：可观测证据桥、健康视图、周期漂移报告。
- **Phase 5（可选）通用化**：抽 adapter 接口；不得降低 A系统 分析质量。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型落后于代码 | 显式假设"agent 维护、人确认"+ Phase 1 出口量化；T0 锚点检查防锚烂；unregistered 检测抓漏注册 |
| 模型本身错误（非漂移） | 节点带 status/confidence；关键节点人工确认；T2 周期漂移报告供人判断 |
| 双事实源过渡混乱 | 规范层/描述层/不可变历史三层分立（§2）；Phase 3 后描述层由生成视图接管 |
| T1 检查拖慢 PR | 派生链追踪只在 T1（Phase 3 才入禁），facts 缓存增量；T0 严格 <5s |
| GWT 膨胀成第二套 prose spec | 模板化 + schema 字段长度强制；长背景链回 prose spec；Phase 1 刻意含 1-2 个 operational GWT 试极限 |
| 模型粒度失控 | 只把有独立边界/状态/推进/恢复语义的流程建成 Loop（沿用调研的五判据） |

## 12. 成功标准（C1 样板完成时）

- Agent 能从一个 Flow 查询出相关 Loop、Junction、GWT 和证据，无需全量读取 spec。
- 人能从同一模型生成可读的大图和局部图。
- 代码变更能映射到受影响模型节点和验证证据。
- GWT 独立于测试代码长期存在（稳定 ID）。
- 关键 Flow 有 E2E 最终闸门；关键 Junction 有契约/集成验证。
- CI 默认不调用 LLM，增量检查不显著拖慢 PR。
- Sandbox 内不可直连上报的 Loop 经间接证据完成可观测映射，不被误报为 drift。
- 模型明确显示 conformant / unverified / drifted 状态，不掩盖缺口。
- 新增量化项：agent 维护模型的耗时与人工确认成本在可接受区间；codeontic check 与既有门禁联合执行不打断本地工作流。
- **诚实基准线（[Report 003](./003-phase0-effectiveness-report.md) 修正后新增，度量方法沿用该报告已验证有效的方法论）**：C1 模型辅助 agent 完成真实理解任务的深度，不输给 目标仓A 现有 `A系统-system-model.md` 对同一链路的描述——不是"比没有文档强"，是"不输给已有的好文档"。度量方法：两个全新、互不知情的 agent 做同一真实理解任务（一个起点是 codeontic C1 模型、一个起点是 `A系统-system-model.md`），对双方回复按准确性/完整性/证据丰富度做 1-5 打分（report 003 §2.2 的量表），codeontic 一侧得分不低于对照——此方法已在 Report 003 的实验中验证可执行，不是新发明的度量。

## 13. 能力边界（明示，不宣称全能）

**完整解决**（结构性/流程性问题）：上下文过载（查询切片）、文档漂移（生成视图 + 漂移检测）、未注册变更、canonical writer 被绕过、跨 loop 影响不可见。

**只能收窄、不能消除**：
1. 模型-意图一致性——工具保证模型-代码一致，不保证模型描述的就是用户想要的行为；GWT 人审不可省。
2. 覆盖度爬坡期空白——N 系区域仅 ID 注册时，查询仍需回读代码/spec；刻意取舍，须明示。
3. 语义级 bug——GWT 对、测试绑定对、但断言弱；codeontic 验证"测试存在且绑定"，不验证"测试写得好"，由测试纪律 + review 承接。

## 14. 反目标（防方案被重新解释）

- 不是以代码为事实源、自动生成 Wiki 的代码理解工具。
- 不是以调用图替代 Feature/Flow/Loop/Junction/GWT 的架构图工具。
- 不是主要依赖 LLM 自动推断业务规范的文档生成器。
- 不在每个 PR 调用 LLM；不全量重建；不建图数据库。
- 不为通用性延迟或削弱 A系统 关键链路建模。
- 不做只报告而永不进入 CI 阻塞路径的旁路系统。
