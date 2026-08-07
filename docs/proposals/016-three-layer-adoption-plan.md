---
title: "Proposal 016: 三层打动路径——首跑完整建模、发现输出、可信门禁"
date: 2026-08-07
status: 方案（待评审，未实施）
scope: init 改造 / agent kit 并行建模指令 / check 跨节点一致性 / conformance 可信度 / overview 信息层级 / CI 方案前提
related:
  - "0.8.0 真实目标仓实测报告(内部验证证据,公开版面已撤下,见 git 历史)"
  - "issue #48（snapshot 在 facts 失败时仍报 comparable——与本案 T6 同病根：数据不可信时报告一切正常）"
  - "本轮证据：三外部仓实测（pi/open-design/novu）+ pi 全仓 60 节点建模，产物索引见附录"
---

# Proposal 016: 三层打动路径

## 定性

**核心价值**：codeontic 的资产是**业务行为的规范性本体**——用封闭词表（loop/flow/junction/scenario/debt）写下"系统应该怎么运转"，锚定到代码符号做取证与执法，方向永不反转（模型是事实源，代码是投影，缺口是代码欠模型的账；描述性 code-graph 结构上说不出"代码错了"）。

它兑现的能力，是在 agent 写码的时代**把"把握方向、做关键判断"的能力还给人**。vibe coding 之后人不再逐行读代码、也读不过来，心智模型以前所未有的速度腐化；这张骨架图让人知道系统有哪些会自己动的机器、逻辑怎么流转、哪里没守住——从而能指出架构问题、决定投入与取舍。**发现清单（debt / gap / 无守卫 junction）是这份判断力的第一次收成与证明，不是价值本身**；持续的价值是地图常新（每 PR 对账）带来的判断力不贬值。本轮实测的 5 个发现没有一个是引擎"报"出来的——4 处重复刷新逻辑（合并决策）、server 包零生产消费者（杀留决策）、死状态机（删除决策）——全是人在并排证据上做出的架构判断，地图的作用是把证据摆到能判断的位置。

判断力 = f(完整, 可信, 行为语言)：部分地图冒充全图会误导判断（覆盖声明，T5）、假 met 会污染判断（信任链，T6）、调用链词汇给不了方向感（行为语言规约，T2）——这就是任务清单的推导来源。

本轮证据（三外部仓实测 + pi 全仓 60 节点）另确认：引擎在 60 节点规模成立（check 亚秒、conformance/overview 正常），但 `init` 到完整画像之间的每一步——分域、id 分配、并行派发、合并裁决、查重、锚点验收——全靠使用者现场发明。本案把这条手工路径固化成产品，按采用者被打动的顺序分三层：

1. **完整建模**（基础，获客）：`init` 的出口是一张完整、用业务语言写的骨架图——方向感的载体，不是五个空目录。
2. **判断力与发现**（价值）：人从图上做出架构判断；建模逼出的欠账抬成报告主角，作为即时证明。
3. **CI/CD 整套方案**（留存）：每 PR 对账让地图保鲜、判断力不随代码漂移贬值——前提是成绩单可信，当前不满足（假 met）。

依赖单向：②的说服力来自①的"这是全部的账"；③依赖②修完 met 可信度。

**两点说破**：

- **冷启动悖论不是悖论**：模型从代码里*发现*（LLM 自下而上产草案），经维护者核实后*成为规范*（自上而下立权威），此后方向不再反转。发现自代码，立规于代码之上。
- **gap 有两种读法**：漂移（曾经守住、现在丢了）与尚未兑现（业务规划了、还没建）。conformance 的语义天然覆盖两者——这使 codeontic 从"防漂移工具"升级为**业务承诺台账**，spec-first 的新行为可以先入模型、带着 gap 出生。

**关键证据（为什么完整建模是发现质量的前提，不只是"更全"）**：pi 全仓建模中，"递归 setTimeout 自我重排"这一 loop 形态在三个互不相关的包独立出现（tui 渲染调度 / sqlite 写者租约心跳 / Codex 会话池 keepalive），`packages/ai` 内 4 处互不共享代码的"查过期→刷新"重复实现——这两类横向模式只有全仓建完才可见。只建单个子系统时（第一轮 8 节点）它们全部缺席。

## 终态

新用户在一个 500+ 文件的仓上：

1. `npx codeontic init` → 声明成本预期（约需 N 分钟、要调用 coding agent）→ 指引进 `/codeontic` 首跑路径；
2. coding agent 按并行建模指令分域建模 → 合并 → `check --strict-anchors` exit 0 且无跨节点重复；
3. 报告页首行是覆盖数字（`52/670 源文件 · 近 26 次提交触达 50%`），主角是发现清单，成绩单作证明；
4. 按需接 CI：advisory conformance + nightly snapshot，分数可信、可当门禁参考。

## 第一层：完整建模（init 的责任）

### T1 init 出口指引与成本声明（文档 + init 文案）

`init` 结束时不再只打印 `created ...`：给出下一步指令（路由到 `/codeontic` skill 的首跑入口）、声明完整建模的时间/token 成本。把成本说在前面是筛选不是劝退。

### T2 并行建模指令 `loop-discovery-parallel.md` + SKILL 路由（agent kit 资产改动）

**实现形态修正**：agent kit 不是仓库里的散文档——全部指令是 `src/cli/assets/agent-kit.ts`（299 行）里的模板常量，经 `init` 的 managed-section 机制（013 B1）写入目标仓并随版本升级幂等更新。新增并行指令 = 加一个导出常量 + 在 init 的 kit 文件清单注册；已接入的目标仓在升级后重跑 `init` 即获得。因此 PR-C 是引擎资产改动、随发版分发，不是"改改文档"。

内容 = 本轮 5 段派发 prompt 的固化 + 两条实测教训：

- **分域按行为归属，不按包归属**：跨包行为（如 compaction：触发在 coding-agent、生成在 agent）必须在分域时显式指定归属，否则两个域各自认领 → 重复建模（本轮 L4/L10 事故）。
- **file-per-node + id 号段 = 天然冲突解**：文件名必须等于节点 id；并行隔离只靠 id 号段分配（`L`/`N` 双前缀共约 200 段位），禁止另加文件名前缀（本轮 30 个 filename-id warning 的成因）。
- **行为语言规约（业务优先）**：`title`/`boundary` 必须用业务行为语言写承诺（"多次变更合并为一帧、刷新节奏有上限"），实现机制进 `notes`/`anchors`（"递归 setTimeout 自我重排"是机制不是行为）。本轮 pi 模型的 title 偏实现词汇（如 "TuiBase 渲染调度循环(requestRender → 节流 setTimeout 自我重排)"），是反例——overview 的"在做什么"栏直接暴露这个问题：给人读的是行为，不是调用链。
- 附：id 前缀约定成文（flow `C\d+`、junction `J-xxx`、scenario `GWT-<id>-NNN`——当前只存在于报错正则里，两个建模 agent 与主控各栽一次）。
- 合并阶段职责清单：重复锚点裁决（人工确认，见"不做清单"）、跨包 flow 补建、自由文本引用核对。

SKILL.md 增加路由：小仓单 agent 走现有 `loop-discovery.md`；大仓（阈值建议 ~150 源文件）走并行指令。

### T3 check 补跨节点一致性（引擎代码，零 LLM 零网络）

当前 check 只校验单节点完整性，跨节点为空白，8 节点靠人眼、60 节点必然失守。三项均为纯静态：

- **重复锚点**：两个节点锚定同一 `path#symbol` → warning（本轮 L4/L10 靠一行 `uniq -c` 人工发现，引擎零提示）；
- **自由文本 id 引用**：`notes`/`boundary`/`summary` 中的 `L\d+[a-z]?`/`C\d+`/`J-[\w-]+` token 对照节点表校验（本轮 "见 L4 auto-retry-backoff" 错误引用存活两轮，且在 L4 真实出现后从"指向空"恶化为"指向无关节点"）;
- 同 parent 子机边界重叠（可后置，初版先做前两项）。

### T4 表达力：`Junction.between` 接受 FlowId（schema 一处）

`src/schema/model.ts:300` 现为 `z.array(LoopId)`，表达不了 Loop↔Flow 交接。0.8.0 已把 Flow 提为一等公民，junction schema 未跟上；open-design 实测中两个发现因此被迫从 junction 降级成 debt，表达力直接丢失。

### T5 覆盖率透传 + overview 分组文案改判据（视图小改）

- backtest 已算出 `52/670 源文件`、`13/26 提交触达`，透传到 overview 页头与 conformance 报告首行。无覆盖数字的"系统地图"会让部分建模被误读为全貌（第一轮 3/670 文件的模型同样自称系统地图）。judgement C 在低覆盖时反向虚高（pi 首轮 2.33 vs 全仓 1.00），必须与覆盖数并排出现。
- **口径必须写明**：文件/提交触达是"搜索彻底度"的代理指标，不是业务完整度。业务完整度的真口径是**行为召回**——对着基准行为清单量漏了几个（校准 001–003 的方法：召回 68%/盲漏 13%/零幻觉），机器算不出真分母。报告措辞不得把代理指标说成完整度。
- overview "后台机器"分组的实际判据是"未被任何 flow 引用"，文案却断言"一直在后台运转的机器"（本轮 21/30 loop 被扫入，含主 REPL 循环与渲染调度）。改为陈述判据，不替读者下结论。

**一层出口判据**：新用户在 500+ 文件仓上，一次引导会话完成全仓建模，`check --strict-anchors` exit 0、零跨节点重复告警、报告带覆盖数字。

## 第二层：判断力与发现

### T6 成绩单可信度（引擎代码；与 issue #48 同病根，一并处理）

- **P0 假 met**：`anchor-symbol` 失配（文件在、符号不存在）时 check 仅 warning、conformance 仍判 `met code✓ test✓`（最小复现 REPRO.sh；novu 实测唯一的 met 背后 3 个测试锚点全部失效）。修法：conformance 消费 check 的失配结果，把失配锚点降级 partial/gap——**不是**把 warning 升 error（anchor-symbol 是全文文本匹配非 AST 解析，crux.ts:27 自承假阴性，升级会误伤）。门禁保持宽松，成绩单保持诚实。
- **anchor 语法支持测试标题**：`[\w.]+` 收不了 `it('claimAsRunning transitions QUEUED -> RUNNING …')` 这类 JS 测试身份，使用者被迫下划线化 → 必然失配 → 必然触发假 met（两缺陷叠成自然触发通路，用户越认真填 verified_by 越容易拿假分）。**不发明新语法**：crux（013 B2，`src/validate/crux.ts`）就是现成的文本锚机制——两级匹配（精确子串 + 去空白归一化）、恒为 warning、明确不被 `--strict-anchors` 提升。verified_by 复用同一机制（如条目支持 `{file, text}` 形态）即可，删除优于新增。
- **实现约束（修法必须尊重）**：conformance 当前对锚点只做单次 `stat`（文件存在性，`conformance.ts:47` 注释明确 sub-second 预算是刻意设计）。消费 symbol 级结果意味着共享 check 的扫描模块（`symbol.ts`/`crux.ts` 已有 2MB 上限的同款机制），不是在 conformance 里重写一遍。
- **执行强度标注**：scenario 的 `level` 字段当前不参与判定，`test✓` 不区分"CI 每次跑的单测"与"需环境变量的 e2e 脚本"（pi 实测 C42：verified_by 指向需 `PI_PROVIDER` 的 smoke.eval.ts，与常规单测在报告中不可区分）。至少在报告中标注成色。
- **`--strict-anchors` 语义对齐**：随上述修复后重述该 flag 的实际承诺，或提供把 anchor-symbol 升 error 的显式选项。

### T7 报告即判断界面（视图）

报告的职责是让一个不读代码的人答出三问：**系统有哪些会自己动的机器？它们怎么接起来？哪里没守住？** 结构上：debt 全量、gap/partial 节点、`test✗` 的 junction、零消费者/死代码类欠账抬到页面顶部作为主角；成绩单退居证明位；flow 叙事与 junction 风险板服务前两问。数据全部已在模型与 conformance 输出中，不新增命令。

## 第三层：CI/CD 整套方案

### T8 门禁方案落地（依赖 T6）

`init` 已生成 `setup-github-actions.md` / `setup-pr-template.md` 骨架。补齐：advisory conformance 报告档进 PR、`--drift-json` 送达（已有）、nightly snapshot。顺手修 adapter ESM/CJS 噪音（init 生成 `.mjs` 或附 `{"type":"module"}` 的 adapter 内 package.json，不要求目标仓改根配置）。

## 不做清单（定价）

- **不做一键全自动合并**：L4/L10 证明自动 merge 会让重复建模静默入库、同一行为计分两次。裁决保留人工确认，目标是"人只做判断，不做发明"。
- **不做引擎内置分域命令**：分域/归属/裁决是判断类工作，归 skill 与指令文档；引擎守零 LLM 零网络红线。
- **不做 findings 新 CLI 命令**：数据已齐，视图层调整即可（T7）。
- **不追求 conformance 语义级验证**（测试是否真的断言了 scenario 的 then）：超出零执行红线，本案只做到"成色标注"。

## 排期与交付切分（少 PR、完整交付）

| PR | 内容 | 性质 | 依赖 |
|---|---|---|---|
| PR-A | T3 + T4（跨节点一致性 + junction 表达力） | 引擎 | 无 |
| PR-B | T6（成绩单可信度，连带 #48） | 引擎 | 无 |
| PR-C | T1 + T2（init 出口 + 并行建模指令） | 引擎资产（agent-kit.ts 常量 + managed-section 注册） | 无 |
| PR-D | T5 + T7（覆盖透传 + 发现置顶 + 分组文案） | 视图 | 无 |
| PR-E | T8（CI 方案） | 文档+小修 | PR-B |

PR-A/B/C/D 互相独立可并行。每个 PR 的验收：在本轮 pi-full 模型（60 节点，见附录）上跑前后对照。

## 缺陷 → 任务映射

| # | 缺陷 | 级别 | 归入 |
|---|---|---|---|
| D1 | conformance 对失效锚点判 met | P0 | T6 |
| D2 | anchor 正则拒绝 JS 测试标题 | P1 | T6 |
| D3 | Junction.between 只收 LoopId | P1 | T4 |
| D4 | --strict-anchors 名不副实 | P2 | T6 |
| D5 | id 前缀约定无文档 | P2 | T2 |
| D6 | adapter ESM/CJS 噪音 | P2 | T8 |
| D7 | overview"后台机器"分组判据与文案错位 | P2 | T5 |
| D8 | 重复锚点无检测 | P1 | T3 |
| D9 | test✓ 不分执行强度（level 形同虚设） | P1 | T6 |
| D10 | 自由文本 id 引用无校验 | P2 | T3 |
| D11 | 覆盖率不可见（judgement C 低覆盖反向虚高） | P1 | T5 |

## 附录：本轮证据产物索引

- 三仓实测汇总与三份完整报告：session scratchpad `EVAL-SUMMARY.md`、`eval-{pi,open-design,novu}/REPORT.md`
- P0 最小复现：`repro-fake-met/REPRO.sh`
- pi 全仓模型（30 loop / 19 flow / 7 junction / 4 debt / 51 scenario，191 锚点逐条验证有效）：`pi-full/pi/.codeontic/model/`
- 5 域并行建模分报告：`pi-full/reports/{agent-core,coding-agent,ai,ui,svc}.md`
- 对照 artifact：8 节点 overview 与 60 节点 overview（同一引擎产物，覆盖差异可视）
