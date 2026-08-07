---
title: "Decision record: external survey (CodeGraph / Google Code Wiki / FSoft CodeWiki / oco-adam SpecGraph)"
date: 2026-07-19
status: "Accepted (决策本身已定案；技术点 1-3 已完成，4/5 核心机制已完成、各自剩余项见下表状态列与文末开放问题)"
related:
  - docs/proposals/001-codeontic-bootstrap.md
---

# 外部调研决策记录

来源：目标仓A PR 内部PR 评论 [#issuecomment-5009238632](https://github.com/目标仓A/pull/1280#issuecomment-5009238632)，对比 CodeGraph（colbymchenry）、Google Code Wiki、FSoft CodeWiki、oco-adam/SpecGraph 四个外部项目。本文档记录该调研对本项目的启发和处置决策，防止后续被重新解释成"没评估过外部方案"或反过来被解释成"应该直接采用某个外部方案"。

## 背景：命名冲突与改名

调研对比的第四个项目 `oco-adam/SpecGraph` 与本项目原名（`specgraph`）撞名——这个名字是在不知道该项目存在的情况下起的。本项目自 2026-07-19 起改名为 **`codeontic`**，理由：

1. 消除与外部项目的命名混淆（调研评论本身已经是一次混淆现场）。
2. 新名字更准确地反映本项目的差异化定位——一等 Loop/Flow/Junction（见下），不是通用的"规范图"框架。
3. 仓库当时只有 2 天历史，改名成本最低。

改名范围：GitHub repo、本地目录、`package.json`/CLI 命令名（`specgraph` → `codeontic`）、全部文档引用。执行细节见改名提交本身，不在本文档重复。

## 决策 1：不切换到 oco-adam/SpecGraph 作为内核

**结论：继续用已建的自研内核，不切换。**

理由（三条独立否决项，任一条即可成立）：

1. **License 不明**——调研自己指出"GitHub API 未显示明确 license，在澄清前只借鉴公开思想和接口设计，不复制或集成实现代码"。
2. **成熟度/社区信号弱**——该项目 2026-02 创建，MCP v0.5.1，社区信号很弱，绑定长期路线风险高。
3. **换轨对已验证内核是纯 churn**——codeontic 的自研内核（Zod schema、YAML loader、T0 checker）已经合入 main 并通过真实 目标仓A 验证（8 loop 挂真实锚点全部解析成功，真实使用中发现并修复 2 个 bug，见 [效果报告](./003-phase0-effectiveness-report.md)）。放弃一个已验证的实现去换一个更年轻、license 不明的实现，没有收益只有风险。

## 决策 2：不扩概念集

**结论：继续冻结 6 概念（Feature/Flow/Loop/Junction/Scenario/DebtEntry），不引入外部 SpecGraph 的 `decision`/`api_contract`/`data_model`/`policy`/`domain`/`layer` 等额外一等节点类型。**

理由：

- 目标仓A 的 `packages/contracts` 和 migrations 本身就是 `api_contract`/`data_model` 这两类内容的既有事实源；codeontic 的 Evidence 锚点已经能指向它们（例如 `packages/contracts#WorkerProtocolEnvelope`），不需要在模型里重复建模一遍。
- `decision`（架构决策记录）类叙事内容按 proposal 001 §2.2 的既有划分留在 prose spec——[效果报告](./003-phase0-effectiveness-report.md) §2.3 已经用真实 A/B 实验证明了 prose 承载历史叙事/决策动机确有优势，把这类内容硬塞进结构化模型不会更好。
- 6 概念冻结是 proposal 001 §0.7"schema 和概念数量必须克制"的落实。扩展概念集需要显式修订这条决策，不因为某个外部项目有类似概念就跟进。

## 决策 3：吸收的具体技术点（按落地阶段）

以下是调研中判断值得吸收、且已排入路线的具体设计，逐条注明来源和落地状态：

| # | 技术点 | 来源 | 落地阶段 | 状态 |
|---|---|---|---|---|
| 1 | 图完整性检查：环检测（`Loop.parent`、`Flow.references`） | oco-adam/SpecGraph 的 graph integrity（referential integrity / self-reference / cycle 检测） | T0（现在） | **已完成**——`checkGraphAcyclic`，标准 DFS 反向边检测，覆盖两条同 kind 边（范围完备性论证见代码注释），2026-07-19 合入 |
| 2 | Effective constraints（约束传播） | oco-adam/SpecGraph 最核心的机制 | Phase 1/2 | **已完成**——`src/query/effective-constraints.ts`：`Scenario.applies_to`(`nodes`+`owner_match`)，query-time 解析不物化，`owner_match` 子串包含语义已按真实种子数据(L16)修正+禁止空字符串，`applies_to.nodes` 引用完整性并入 `checkReferentialIntegrity`，2026-07-19 合入 |
| 3 | file-per-node（节点文件存自身出边，反向边查询时算） | oco-adam/SpecGraph | Phase 1（深建模节点起） | **已完成**——C1 的 5 个 junction 已从数组文件迁移为 file-per-node，`model/junctions/<id>.yaml`，2026-07-19 合入；种子 loop/flow 仍不迁移（决策不变） |
| 4 | side-channel 输出带 staleness 戳 | CodeGraph（显式 stale、禁止静默返回旧结果） | Phase 2 | **生成与比较原语已完成，主动警告消费端未实现**——`src/staleness.ts`：`computeStalenessStamp`（model 内容 sha256 + best-effort git head/dirty）随 `codeontic view` 一起写入 side-channel 文件头部注释；`isStale` 只比较 `modelContentHash`，`generatedAt`/`repoHead`/`repoDirty` 仅作人读上下文，不参与判定，2026-07-19 合入。**但** CodeGraph 原始目标"禁止静默返回旧结果"里的主动防护部分——某条命令读取历史 stamp、重新计算、发现不一致就主动警告或拒绝——目前没有任何调用方，`isStale`/`parseStalenessBanner` 还只是可比较的原语，见文末开放问题 |
| 5 | views 生成加 Mermaid 渲染校验（写出即验证） | FSoft CodeWiki | Phase 1（C1 大图） | **已完成**——`codeontic view <flow-id>`（当前仅 C1 范围）纯函数生成 mermaid（`src/views/flow-mermaid.ts`），`--validate` 时用 `@mermaid-js/mermaid-cli`（devDependency，不进 `dependencies`，不随 codeontic 进消费方安装）实际渲染校验；生成器本身的正确性由 codeontic 自己的测试套件用真实 mmdc 验证，2026-07-19 合入 |
| 6 | 单一高层查询入口 + file side-channel 传大数据 | CodeGraph / FSoft CodeWiki | 已是 proposal 001 §4.2 的既定设计 | 与 codeontic 原设计一致，非新增 |
| 7 | CI 默认不调 LLM、Tree-sitter/AST 分析与 Agent 推理解耦 | CodeGraph / FSoft CodeWiki | 已是 proposal 001 §0.7 的既定约束 | 与 codeontic 原设计一致，非新增 |

### 技术点 2：Effective constraints 最小设计草案

Invariant 型 Scenario 节点增加可选 `applies_to` 选择器字段，决定该不变式在查询时自动出现在哪些节点的结果里（而不是只能靠 junction/loop 手工把 scenario ID 塞进 `scenarios` 数组）：

- **v1 只做两种谓词**：
  - `nodes: [id, ...]` — 对全部 6 种 kind 有效，按 ID 精确匹配。
  - `owner_match: "packages/control-plane"` — **仅对 Loop 有效**；`owner: null` 的 dormant loop 永不命中；`applies_to` 内的其他谓词以 **OR** 语义合并（命中任一谓词即视为该不变式适用）。**匹配语义是子串包含（substring containment），不是前缀锚定或 POSIX glob**——核对种子真实数据后发现 `Loop.owner` 是自由文本（可能混排中文连接词，如 L16 的 `"canonical writer = packages/control-plane run-service;agent-worker 仅作事件源..."`），"packages/control-plane" 不出现在开头；若按前缀匹配，这类 loop 会被漏判。规则：不含 `*` 的模式按子串包含判断（出现在 `owner` 字符串任意位置即命中）；模式中的 `*` 等价于"任意长度任意字符"（类似简化正则 `.*`），用于需要限定顺序关系的场景（如 `"packages/control-plane*apps/control-worker"` 要求两者按此顺序出现）。不支持 `**`、字符类等完整 glob 语法——`owner` 是短自由文本不是文件路径，不需要那套语义。大小写敏感，与 `owner` 原始大小写一致。**字面量 `*` 转义**：核对全部种子 `owner` 值，当前没有任何一条包含字面量 `*` 字符（已用 grep 验证），v1 不实现转义语法；若未来出现需要匹配字面量 `*` 的 owner 文本，再补转义规则，不预先设计不存在的需求。
  - 原设想的第三个谓词 `state_carrier_glob` **v1 明确不做**：核对 schema 后发现 `Loop` 当前没有独立的 `state_carrier` 结构化字段——`内部PR` 表格的"边界/状态"列被忠实转录进了自由文本 `boundary`，对自由文本做 glob 是伪精确，不做。留待 Phase 1 深建模阶段给 Loop 加可选的结构化 `state_carrier` 字段后再引入。**该"留待"已在 Proposal 006 A2 决策收口：暂不加字段，见下方"决策记录 A2"** —— 因此这个谓词继续不做，其触发条件绑定到 A2 记录的 re-trigger 上。
- **触发时机**：query-time 动态计算，不物化。理由与外部 SpecGraph 的"反向边查询时计算"同——物化会让每次新增 invariant 都要回写全部命中节点，在用户几百个 git worktree 并行开发的场景下会持续制造 merge 冲突；模型规模是几百节点量级，query-time 全量匹配是微秒级操作，物化没有性能收益，只有一致性维护成本。
- **与 T0 的边界**：T0 只校验 `applies_to` 选择器本身的语法合法性 + `nodes` 列表引用存在（并入现有 `checkReferentialIntegrity`）；**传播结果本身不进 T0**——"某条不变式是否适用于某个节点"是查询语义，不是一致性约束，把它塞进 T0 会让 T0 的确定性依赖 glob 匹配逻辑，违反 T0"只做廉价确定性检查"的定位（proposal 001 §6）。
- **实现时的测试要求（记在这里，防止实现阶段遗漏）**：`applies_to` 的匹配逻辑本身虽然不进 T0，但必须有独立的单元测试覆盖——匹配逻辑错误会导致查询结果静默错误（该不变式该出现的地方没出现，或出现在不该出现的地方），且没有任何门禁能自动兜底这类错误，所以正确性完全依赖测试。实现 PR 必须包含：`owner_match` 子串命中/不命中的边界用例（含 `owner: null` 的 dormant loop、含 L16 这类 "packages/control-plane" 不在开头的真实混排文本）、`nodes` 精确匹配用例、多谓词 OR 语义用例。

### 决策记录 A2：Loop `state_carrier` 结构化字段 —— 暂不加（2026-07-20，Proposal 006 A2）

**决策：不加 `state_carrier` 字段。** A2 的真正交付物是这份决策记录本身（006 A2 验收："决策记录 + （若加字段）schema 变更"），计划对"加/不加"是中性的。判据：**只在能指名一个 A3–A7 会真实构建的消费者时才加**——核对后当前 A-相位无此消费者。

先把 C1 七个 loop 的真实状态载体核实清楚（对 目标仓A 当前 HEAD 实查，不照抄 内部PR 自由文本），这就是"深建模阶段核对状态载体"的产出：

| Loop | 载体类型 | 具体载体（目标仓A 实查） | 锚点 |
|---|---|---|---|
| L1 Session Startup | db_column | 目标仓A-v2 session 状态列（`created→provisioning→starting→ready`，五态两终态） | `packages/db/src/schema/目标仓A-v2-sessions.ts` |
| L2 Run/Turn | db_column | `runs.status` varchar(50) default `queued`（另有 `runs.delivery_phase` 辅助列，目标仓A 该 schema 注释明确其 NOT part of `runs.status` enum，是投递相位辅助列而非主状态） | `packages/db/src/schema/runs.ts:25` |
| L15 Worker-Protocol Job | db_column | `worker_protocol_jobs.status` varchar(20) default `queued`（`FOR UPDATE SKIP LOCKED`，retry budget 3） | `packages/db/src/schema/worker-protocol-jobs.ts:231` |
| L16 Backward Wire 投影 | db_column（投影目标，与 L2 共享） | 写入 `runs.status`——即 canonical writer=run-service，worker 事件源仅触发 | `packages/control-plane/src/run/run-service.ts#RunService` |
| L9 V2 Worker Health Watcher | db_column | DB 化失败计数列（跨副本一致，连续 5 次失败→run failed） | `apps/control-worker/src/orchestration/v2-health-watcher.ts#V2WorkerHealthWatcher` |
| L3 Agent 执行 loop | in_memory | `streamText()` 的 `fullStream`，无持久状态列（真实 tool loop 在 CLI 子进程内） | `apps/agent-worker`（stream 消费） |
| L4 Delivery Pipeline | in_memory | 内存 `DeliveryResult`（永不 throw），仅 checkpoint 落库 | `apps/agent-worker/src/v2/delivery/index.ts#runDelivery` |

**为什么现在不加（逐条排除消费者）：**
- **A3**（第一条 INV-1 场景）用 `applies_to.owner_match` 定位（其验收明确是 `resolveApplicableScenarios` 对 L16 按 owner 断言），不用 `state_carrier`。
- **A4**（深建模七 loop）"若字段存在就填它"是循环论证，不算消费者。
- **A6**（INV-1 执法）列清单放 `codeontic.config.ts`，扫描原语是 (文件内容, 列清单, allowlist) 的纯函数，**不读 loop 节点**——按 006 A6 既定范围，扫描器与 `state_carrier` 无耦合。
- 曾设想的"A6 顺带对账 config 守护列 ↔ loop 声明载体（每个 canonical 列恰被一个 loop 声明；≥2 个即投影 junction）"是不错的完整性检查，但**不在 006 A6 范围内**；为给字段找消费者而扩 A6 范围＝scope creep，目标未要求，不做。
- "让 L2/L16 共享 `runs.status` 的投影关系机器可见"**不成立为加字段的理由**——该投影已由 `J-backward-wire`（risk_class: projection, between L16/L2）一等公民承载，`state_carrier` 不新增任何 junction 已有的可见性。

**Re-trigger（满足任一即重新评估加字段，届时按消费者需求定形状，不预先猜）：**
1. **需求驱动**：出现一条**必须区分共享同一 db_column 的多个 Loop**（如 L2 与 L16 都落在 `runs.status`）、或**必须跨 Loop 对账载体一致性**的真实不变式，而 `owner_match`（对自由文本 `owner` 的子串匹配）无法表达这种"按表/列定位"的语义——从而确定要实现 effective-constraints 的 `state_carrier` 谓词（技术点 2 中 deferred 的 `state_carrier_glob`）。**边界澄清**：C1 现状里 L2/L16 共享 `runs.status` 这个"事实"本身不构成触发——触发的是"出现了需要按此事实做机器判定的**不变式需求**"。A3–A7 的第一条 INV-1 场景用 `owner_match` 即可表达（canonical writer 是谁），没有产生上述需求，故当前未触发。因果方向是"先有真实不变式需求 → 才决定建谓词 → 才需要字段"，不是"因为想建谓词所以加字段"的自锁循环。
2. **范围决策驱动**：项目未来产出一份**独立论证 A6"config 守护列 ↔ loop 声明载体"对账检查价值的设计文档**（该论证不依赖 `state_carrier` 字段是否已存在），并据此把对账检查纳入 A6 范围。用"是否存在这样一份独立论证的交付物"这个可观测客观条件替代主观动机判定：这与本决策不矛盾——本决策反对的是"没有独立价值论证、纯为给字段凑消费者而临时扩 A6 范围"（scope creep）；有了独立价值论证的主动范围调整则是正当触发，加字段只是其副产物。
**形状完全由届时消费者定，下面只是一个指示性起点、不是最终设计**：可能是最小判别联合 `db_column {table, column}` + `in_memory` 逃逸（C1 无 file/external 载体，不预建这两个变体）——但注意本表 L3/L4 的 `in_memory` 载体粒度是具体内存对象（`fullStream`/`DeliveryResult`），若消费者需要定位到这一粒度，`in_memory` 变体可能要带结构而不止是标记，这些都留给消费者驱动时再定。这与本项目既有纪律一致——staleness 消费端、拒绝为实验编造 invariant 数据，都是"有真实消费者再建"。

**成本不对称佐证：** 推迟只承担"日后再扫一遍 7 个 YAML"的廉价二次成本，且届时形状由消费者驱动、必然正确；现在加则把一个"猜的形状"传导进 A3（最高杠杆任务）。两条路都不阻塞 A3。

### 技术点 3：file-per-node 的目录/命名约定

- 目录：`model/<kind目录>/<id>.yaml`（例如 `model/junctions/J-outbox-poller.yaml`）。
- 命名：文件名（去掉 `.yaml` 后缀）必须等于节点的 `id` 字段；不一致时 T0 告警（Phase 1 随 file-per-node 迁移一起实现该检查，不在本次范围）。
- 适用范围：Phase 1 起新增的深建模节点（junction 的 GWT/evidence 等）用 file-per-node；已有的种子 loop/flow **不迁移**——种子数组文件按 `内部PR` 的 §3.x 分节组织，这个分组本身就是 drift 测试忠实性核对的锚点（`test/support/parse-research.ts` 按章节边界解析），拆成 file-per-node 会破坏这个映射关系，且种子内容本来就是只读转录，不像深建模节点那样需要频繁独立编辑，不需要 file-per-node 带来的合并冲突隔离收益。**这是当前判断，不是永久约束**——若种子 loop 未来需要频繁独立编辑（例如从只读转录变成持续维护的活文档），届时应重新评估是否迁移，不必现在预留迁移路径，但也不应把"种子不迁移"当成一条不可讨论的规则。
- loader 支持情况：`loadModel` 已经按 `Array.isArray` 分支处理单节点/数组两种文件形态，`test/loader.test.ts` 的现有用例（`test/fixtures/valid-model/flows/c1.yaml` 就是单节点文件）持续通过；种子里 `junctions/c1-junctions.yaml` 目前是数组文件，Phase 1 拆分成 file-per-node 时**零 loader 代码改动**，纯目录/文件组织调整。
- **混合模式是允许的，不要求"全有或全无"**：`loadModel` 按文件逐个判断形态（walk 全目录、每个文件独立解析），不要求同一 `kind` 目录下所有文件统一成单节点或统一成数组。即使未来种子迁移，也不需要"一次性全量转 file-per-node"——数组文件（种子）和单文件（深建模节点）可以在同一目录长期共存，这不是过渡态而是稳定支持的形态。
- **异常兜底不是新问题，是既有能力**：单节点文件若解析出的内容不符合 `ModelNode` schema（字段缺失、`kind` 错误等），走的是已经上线并测试覆盖的路径——`ModelNode.safeParse` 逐元素校验失败进 `parseErrors`，携带文件名定位，不会让 `loadModel` 崩溃或静默吞掉（`test/loader.test.ts` 的 "collects schema/parse errors instead of throwing" 用例已覆盖）。file-per-node 不引入新的校验需求，只是把"元素"从数组里的一项变成整个文件本身，兜底逻辑不变。

## 不在本次范围内的开放问题

- 约束传播（技术点 2）、file-per-node 迁移（技术点 3）、Mermaid 视图生成校验（技术点 5）均已完整实现；staleness 戳（技术点 4）的生成与比较原语已实现，但"检测到过期主动警告"这一原始目标的消费端部分未实现（均 2026-07-19，见上表）。技术点 4/5 是借同一个新命令 `codeontic view` 一并落地的——proposal 001 §4.2 设计过的 `model inspect`/`model impact`/`model plan`/`model scenario`/`model evidence` 完整查询命令族仍未实现，`view` 只是其中最小可用的一个查询/视图切片，不是补全了整族。
- `owner_match` 之外是否需要更多谓词（例如按 `section` 或 `risk_class` 匹配），留到实际使用中发现真实需求再加，不预先设计。
- staleness 戳目前没有任何命令会主动读取 side-channel 文件并警告"这份已经过期"——`isStale`/`parseStalenessBanner` 只是可比较的原语，还没有消费者。C1 之外的 8 个 Flow 也还没有 `view` 支持（scope 沿用 proposal 001 §12 的 C1 样板范围）。这两项留给下一次真正需要时再做，不预先建。
